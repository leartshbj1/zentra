#!/usr/bin/env python3
"""Verify a real-device ARM64 IPA and prepare its unsigned sideload artifact."""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import zipfile


def verify(ipa):
    config = json.loads((Path(__file__).parents[1] / "src-tauri/tauri.conf.json").read_text())
    with zipfile.ZipFile(ipa) as archive:
        if archive.testzip() is not None:
            raise ValueError("Corrupt IPA archive")
        roots = [name for name in archive.namelist()
                 if name.startswith("Payload/") and name.count("/") == 2
                 and name.endswith(".app/Info.plist")]
        if len(roots) != 1:
            raise ValueError("Expected exactly one Payload/*.app/Info.plist")
        info = plistlib.loads(archive.read(roots[0]))
        if info.get("CFBundleIdentifier") != "ch.zentra.mobile":
            raise ValueError("Unexpected application identifier")
        if info.get("CFBundleShortVersionString") != config["version"]:
            raise ValueError("IPA version does not match the source version")
        if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
            raise ValueError("IPA must target a physical iPhone, not a simulator")
        executable = info.get("CFBundleExecutable", "")
        if not executable or "/" in executable or "\\" in executable:
            raise ValueError("Invalid executable name")
        binary = archive.read(roots[0].removesuffix("Info.plist") + executable)
        magic, cpu, _, filetype, commands, command_bytes, _, _ = struct.unpack_from("<8I", binary)
        if (magic, cpu, filetype) != (0xFEEDFACF, 0x0100000C, 2):
            raise ValueError("Expected an ARM64 Mach-O executable")
        offset = 32
        limit = offset + command_bytes
        if limit > len(binary):
            raise ValueError("Truncated Mach-O load commands")
        device_platform = False
        for _ in range(commands):
            if offset + 8 > limit:
                raise ValueError("Truncated Mach-O load command")
            command, size = struct.unpack_from("<2I", binary, offset)
            if size < 8 or offset + size > limit:
                raise ValueError("Invalid Mach-O load command")
            if command == 0x32:  # LC_BUILD_VERSION: iOS = 2, iOS Simulator = 7
                if size < 24 or struct.unpack_from("<I", binary, offset + 8)[0] != 2:
                    raise ValueError("Mach-O was not compiled for physical iOS")
                device_platform = True
            elif command == 0x25:  # LC_VERSION_MIN_IPHONEOS, older toolchains
                device_platform = True
            offset += size
        if not device_platform or offset != limit:
            raise ValueError("Missing or invalid native iOS platform metadata")
        if any(name.endswith("embedded.mobileprovision") for name in archive.namelist()):
            raise ValueError("This unsigned delivery must not include a provisioning profile")
    return {
        "application": "Zentra",
        "version": info["CFBundleShortVersionString"],
        "bundle_identifier": info["CFBundleIdentifier"],
        "minimum_ios": info.get("MinimumOSVersion"),
        "architecture": "arm64",
        "platform": "iPhoneOS",
        "signing": "Requires signing with Sideloadly or AltStore before installation",
        "physical_device_tested": False,
        "size_bytes": ipa.stat().st_size,
        "sha256": hashlib.file_digest(ipa.open("rb"), "sha256").hexdigest(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ipa", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--source-revision")
    args = parser.parse_args()
    result = verify(args.ipa)
    result["source_revision"] = args.source_revision
    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        name = f"Zentra-{result['version']}-iPhone-unsigned.ipa"
        shutil.copy2(args.ipa, args.output_dir / name)
        (args.output_dir / "build-info.json").write_text(json.dumps(result, indent=2) + "\n")
        (args.output_dir / "SHA256SUMS.txt").write_text(f"{result['sha256']}  {name}\n")
    print(json.dumps(result, indent=2))
