use crate::error::{AppError, AppResult};

#[cfg(target_os = "ios")]
const SERVICE: &str = "ch.zentra.mobile.protected-data";
#[cfg(target_os = "ios")]
const PREFIX: &str = "zentra-ios-keychain-v1:";

#[cfg(target_os = "ios")]
pub fn protect(clear: &[u8]) -> AppResult<Vec<u8>> {
    let account = uuid::Uuid::new_v4().to_string();
    security_framework::passwords::set_generic_password(SERVICE, &account, clear).map_err(
        |_| AppError::Validation("Le trousseau iOS a refusé l’enregistrement sécurisé.".into()),
    )?;
    Ok(format!("{PREFIX}{account}").into_bytes())
}

#[cfg(target_os = "ios")]
fn account(protected: &[u8]) -> AppResult<&str> {
    let account = std::str::from_utf8(protected)
        .ok()
        .and_then(|value| value.strip_prefix(PREFIX))
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| AppError::Validation("Référence du trousseau iOS invalide.".into()))?;
    Ok(account)
}

#[cfg(target_os = "ios")]
pub fn unprotect(protected: &[u8]) -> AppResult<Vec<u8>> {
    security_framework::passwords::get_generic_password(SERVICE, account(protected)?)
        .map_err(|_| AppError::Validation("Identifiant absent ou inaccessible dans le trousseau iOS. Reconnectez cet appareil.".into()))
}

#[cfg(target_os = "ios")]
pub fn forget(protected: &[u8]) {
    if let Ok(account) = account(protected) {
        let _ = security_framework::passwords::delete_generic_password(SERVICE, account);
    }
}

#[cfg(target_os = "android")]
const ANDROID_PREFIX: &[u8] = b"zentra-android-keystore-v1:";
#[cfg(target_os = "android")]
static ANDROID_KEY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "android")]
pub fn protect(clear: &[u8]) -> AppResult<Vec<u8>> {
    android_crypt(clear, true)
}

#[cfg(target_os = "android")]
pub fn unprotect(protected: &[u8]) -> AppResult<Vec<u8>> {
    let data = protected
        .strip_prefix(ANDROID_PREFIX)
        .filter(|bytes| bytes.len() >= 28)
        .ok_or_else(|| AppError::Validation("Identifiant Android protégé invalide.".into()))?;
    android_crypt(data, false)
}

#[cfg(target_os = "android")]
pub fn forget(_protected: &[u8]) {
    // The single device key protects other local records too. Android removes it on uninstall.
}

#[cfg(target_os = "android")]
fn android_crypt(bytes: &[u8], encrypt: bool) -> AppResult<Vec<u8>> {
    use jni::{
        objects::{JByteArray, JObject, JValue},
        JavaVM,
    };
    let fail = || {
        AppError::Validation(
            "Le coffre sécurisé Android est indisponible. Déverrouillez l’appareil puis réessayez."
                .into(),
        )
    };
    let _guard = ANDROID_KEY_LOCK.lock().map_err(|_| fail())?;
    // Tauri uses Tao's Activity context, not ndk-context's NativeActivity global.
    // Tao initializes this context before invoking the Rust entry point.
    let context =
        tauri::tao::platform::android::prelude::main_android_context().ok_or_else(fail)?;
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) }.map_err(|_| fail())?;
    let mut env = vm.attach_current_thread().map_err(|_| fail())?;
    let result = env.with_local_frame(64, |env| -> jni::errors::Result<Vec<u8>> {
        let provider = JObject::from(env.new_string("AndroidKeyStore")?);
        let alias = JObject::from(env.new_string("ch.zentra.mobile.protected-data.v1")?);
        let store = env
            .call_static_method(
                "java/security/KeyStore",
                "getInstance",
                "(Ljava/lang/String;)Ljava/security/KeyStore;",
                &[JValue::Object(&provider)],
            )?
            .l()?;
        env.call_method(
            &store,
            "load",
            "(Ljava/io/InputStream;[C)V",
            &[
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
            ],
        )?;
        let mut key = env
            .call_method(
                &store,
                "getKey",
                "(Ljava/lang/String;[C)Ljava/security/Key;",
                &[JValue::Object(&alias), JValue::Object(&JObject::null())],
            )?
            .l()?;
        if key.is_null() && encrypt {
            let builder = env.new_object(
                "android/security/keystore/KeyGenParameterSpec$Builder",
                "(Ljava/lang/String;I)V",
                &[JValue::Object(&alias), JValue::Int(3)],
            )?;
            let gcm = env.new_string("GCM")?;
            let modes = JObject::from(env.new_object_array(1, "java/lang/String", &gcm)?);
            env.call_method(
                &builder,
                "setBlockModes",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Object(&modes)],
            )?;
            let no_padding = env.new_string("NoPadding")?;
            let paddings =
                JObject::from(env.new_object_array(1, "java/lang/String", &no_padding)?);
            env.call_method(
                &builder,
                "setEncryptionPaddings",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Object(&paddings)],
            )?;
            env.call_method(
                &builder,
                "setKeySize",
                "(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Int(256)],
            )?;
            let spec = env
                .call_method(
                    &builder,
                    "build",
                    "()Landroid/security/keystore/KeyGenParameterSpec;",
                    &[],
                )?
                .l()?;
            let aes = JObject::from(env.new_string("AES")?);
            let generator = env
                .call_static_method(
                    "javax/crypto/KeyGenerator",
                    "getInstance",
                    "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
                    &[JValue::Object(&aes), JValue::Object(&provider)],
                )?
                .l()?;
            env.call_method(
                &generator,
                "init",
                "(Ljava/security/spec/AlgorithmParameterSpec;)V",
                &[JValue::Object(&spec)],
            )?;
            key = env
                .call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])?
                .l()?;
        }
        if key.is_null() {
            return Err(jni::errors::Error::NullPtr("missing device key"));
        }
        let transformation = JObject::from(env.new_string("AES/GCM/NoPadding")?);
        let cipher = env
            .call_static_method(
                "javax/crypto/Cipher",
                "getInstance",
                "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
                &[JValue::Object(&transformation)],
            )?
            .l()?;
        let data;
        if encrypt {
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;)V",
                &[JValue::Int(1), JValue::Object(&key)],
            )?;
            data = bytes;
        } else {
            let iv = JObject::from(env.byte_array_from_slice(&bytes[..12])?);
            let spec = env.new_object(
                "javax/crypto/spec/GCMParameterSpec",
                "(I[B)V",
                &[JValue::Int(128), JValue::Object(&iv)],
            )?;
            env.call_method(
                &cipher,
                "init",
                "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
                &[JValue::Int(2), JValue::Object(&key), JValue::Object(&spec)],
            )?;
            data = &bytes[12..];
        }
        let input = JObject::from(env.byte_array_from_slice(data)?);
        let output = JByteArray::from(
            env.call_method(&cipher, "doFinal", "([B)[B", &[JValue::Object(&input)])?
                .l()?,
        );
        let output = env.convert_byte_array(&output)?;
        if !encrypt {
            return Ok(output);
        }
        let iv = JByteArray::from(env.call_method(&cipher, "getIV", "()[B", &[])?.l()?);
        let iv = env.convert_byte_array(&iv)?;
        if iv.len() != 12 {
            return Err(jni::errors::Error::NullPtr("invalid nonce length"));
        }
        Ok([ANDROID_PREFIX, &iv, &output].concat())
    });
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.map_err(|_| fail())
}
