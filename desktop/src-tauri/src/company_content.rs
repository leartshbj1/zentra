//! Content-defined transport of an exact, verified company archive. The local
//! cache is disposable; business records are still merged by company_merge.
use crate::{
    cloud_backup::{Chunk, Manifest},
    error::{AppError, AppResult},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MIN: usize = 64 * 1024;
pub(crate) const MAX: usize = 1024 * 1024;
fn invalid() -> AppError {
    AppError::Validation("Un changement est incomplet. Vos données locales sont conservées.".into())
}
fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
const fn gear() -> [u64; 256] {
    let mut values = [0; 256];
    let mut seed = 0x9e3779b97f4a7c15u64;
    let mut i = 0;
    while i < 256 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        values[i] = seed;
        i += 1;
    }
    values
}
const GEAR: [u64; 256] = gear();
pub(crate) fn validate(parts: &[Chunk], manifest: &Manifest) -> AppResult<()> {
    if parts.is_empty() || parts.len() > 8192 {
        return Err(invalid());
    }
    let mut sizes = HashMap::new();
    let mut sum = 0;
    for p in parts {
        if !valid_hash(&p.sha256) || p.size_bytes == 0 || p.size_bytes > MAX as u64 {
            return Err(invalid());
        }
        if sizes
            .insert(&p.sha256, p.size_bytes)
            .is_some_and(|n| n != p.size_bytes)
        {
            return Err(invalid());
        }
        sum += p.size_bytes;
    }
    if sum != manifest.size_bytes {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn directory(root: &Path, organization: &str) -> AppResult<PathBuf> {
    let path = root
        .join("company-content-v1")
        .join(format!("{:x}", Sha256::digest(organization.as_bytes())));
    fs::create_dir_all(&path)?;
    Ok(path)
}
fn path(cache: &Path, hash: &str) -> AppResult<PathBuf> {
    if !valid_hash(hash) {
        return Err(invalid());
    }
    Ok(cache.join(hash))
}
pub(crate) fn cached(cache: &Path, part: &Chunk) -> AppResult<Option<Vec<u8>>> {
    let file = path(cache, &part.sha256)?;
    let metadata = match fs::metadata(&file) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if metadata.len() != part.size_bytes || metadata.len() > MAX as u64 {
        return Ok(None);
    }
    let bytes = fs::read(file)?;
    if format!("{:x}", Sha256::digest(&bytes)) != part.sha256 {
        return Ok(None);
    }
    Ok(Some(bytes))
}
pub(crate) fn put(cache: &Path, part: &Chunk, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() as u64 != part.size_bytes
        || bytes.len() > MAX
        || format!("{:x}", Sha256::digest(bytes)) != part.sha256
    {
        return Err(invalid());
    }
    let target = path(cache, &part.sha256)?;
    let mut temp = tempfile::NamedTempFile::new_in(cache)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(target).map_err(|e| AppError::Io(e.error))?;
    Ok(())
}
/// Rolling boundaries recover after insertion/removal; fixed offsets would
/// resend every following attachment when the compressed database grows.
pub(crate) fn prepare(file: &Path, cache: &Path) -> AppResult<Vec<Chunk>> {
    let mut input = File::open(file)?;
    let mut buffer = [0u8; 65536];
    let mut bytes = Vec::with_capacity(MAX);
    let mut rolling = 0u64;
    let mut parts = Vec::new();
    loop {
        let read = input.read(&mut buffer)?;
        for &byte in &buffer[..read] {
            bytes.push(byte);
            rolling = rolling.wrapping_shl(1).wrapping_add(GEAR[byte as usize]);
            if bytes.len() >= MIN && ((rolling & ((1 << 18) - 1)) == 0 || bytes.len() == MAX) {
                flush(cache, &mut bytes, &mut parts)?;
                rolling = 0;
            }
        }
        if read == 0 {
            break;
        }
    }
    if !bytes.is_empty() {
        flush(cache, &mut bytes, &mut parts)?;
    }
    Ok(parts)
}
fn flush(cache: &Path, bytes: &mut Vec<u8>, parts: &mut Vec<Chunk>) -> AppResult<()> {
    if parts.len() >= 8192 {
        return Err(invalid());
    }
    let part = Chunk {
        sha256: format!("{:x}", Sha256::digest(&*bytes)),
        size_bytes: bytes.len() as u64,
    };
    if cached(cache, &part)?.is_none() {
        put(cache, &part, bytes)?;
    }
    parts.push(part);
    bytes.clear();
    Ok(())
}
/// Only disposable content-addressed files in this private cache are evicted.
/// A cache miss always fetches and verifies the original bytes again.
pub(crate) fn trim(cache: &Path) -> AppResult<()> {
    let mut files = Vec::new();
    let mut total = 0;
    for entry in fs::read_dir(cache)? {
        let entry = entry?;
        if !valid_hash(&entry.file_name().to_string_lossy()) || !entry.file_type()?.is_file() {
            continue;
        }
        let meta = entry.metadata()?;
        total += meta.len();
        files.push((meta.modified()?, meta.len(), entry.path()));
    }
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= 1024 * 1024 * 1024 {
            break;
        }
        fs::remove_file(path)?;
        total -= size;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shifted_attachment_bytes_are_reused_and_corrupt_cache_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let cache = directory(dir.path(), "company-a").unwrap();
        let mut seed = 42u64;
        let original: Vec<u8> = (0..12 * 1024 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed as u8
            })
            .collect();
        let a = dir.path().join("a");
        fs::write(&a, &original).unwrap();
        let before = prepare(&a, &cache).unwrap();
        let mut modified = original.clone();
        modified.splice(
            12345..12345,
            b"a new invoice paid by another colleague".iter().copied(),
        );
        let b = dir.path().join("b");
        fs::write(&b, &modified).unwrap();
        let after = prepare(&b, &cache).unwrap();
        let existing: std::collections::HashSet<_> = before.iter().map(|p| &p.sha256).collect();
        let changed: u64 = after
            .iter()
            .filter(|p| !existing.contains(&p.sha256))
            .map(|p| p.size_bytes)
            .sum();
        assert!(
            changed < 2 * MAX as u64,
            "changed {changed} / {}",
            modified.len()
        );
        let assembled: Vec<u8> = after
            .iter()
            .flat_map(|p| cached(&cache, p).unwrap().unwrap())
            .collect();
        assert_eq!(assembled, modified);
        let part = &after[0];
        fs::write(
            path(&cache, &part.sha256).unwrap(),
            vec![0; part.size_bytes as usize],
        )
        .unwrap();
        assert!(cached(&cache, part).unwrap().is_none());
        assert!(path(&cache, "../outside").is_err());
        assert_ne!(cache, directory(dir.path(), "company-b").unwrap());
        println!("CONTENT_DELTA {} / {} bytes", changed, modified.len());
    }
}
