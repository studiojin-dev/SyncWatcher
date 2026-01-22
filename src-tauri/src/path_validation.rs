use std::path::{Path, PathBuf};

/// Maximum allowed path length for security
const MAX_PATH_LENGTH: usize = 4096;

/// Validate that a path is safe and doesn't contain suspicious patterns
pub fn validate_path(path: &str) -> Result<(), String> {
    // Check path length
    if path.len() > MAX_PATH_LENGTH {
        return Err(format!("Path too long (max {MAX_PATH_LENGTH} bytes)"));
    }

    let path_obj = Path::new(path);

    // Check for null bytes
    if path.bytes().any(|b| b == 0) {
        return Err("Path contains null bytes".to_string());
    }

    // Check for obvious path traversal attempts
    let path_str = path_obj.to_string_lossy();
    if path_str.contains("../") || path_str.contains("..\\") {
        return Err("Path traversal detected (../)".to_string());
    }

    // Check for suspicious patterns
    if path_str.contains("$") || path_str.contains("`") {
        return Err("Path contains suspicious characters".to_string());
    }

    Ok(())
}

/// Sanitize and validate a path, ensuring it stays within base directory
pub fn sanitize_path(base: &Path, user_path: &Path) -> Result<PathBuf, String> {
    // Validate base path exists
    if !base.exists() {
        return Err("Base directory does not exist".to_string());
    }

    // Join paths
    let joined = base.join(user_path);

    // Canonicalize both paths (resolves all .., ., symlinks)
    let canonical = joined.canonicalize().map_err(|e| {
        format!("Invalid path: {e}")
    })?;

    let base_canonical = base.canonicalize().map_err(|e| {
        format!("Invalid base path: {e}")
    })?;

    // Verify the joined path starts with base path (prevents traversal)
    if !canonical.starts_with(&base_canonical) {
        return Err("Path traversal detected: attempted to access outside base directory".to_string());
    }

    Ok(canonical)
}

/// Validate that a path exists and is accessible
pub fn verify_path_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_validate_path_rejects_traversal() {
        assert!(validate_path("../etc/passwd").is_err());
        assert!(validate_path("..\\windows\\system32").is_err());
    }

    #[test]
    fn test_validate_path_rejects_null_bytes() {
        assert!(validate_path("test\0file").is_err());
    }

    #[test]
    fn test_validate_path_accepts_valid() {
        assert!(validate_path("/tmp/test").is_ok());
        assert!(validate_path("C:\\Users\\test").is_ok());
    }

    #[test]
    fn test_sanitize_path_blocks_traversal() {
        let temp_dir = TempDir::new().unwrap();
        let base = temp_dir.path();

        // Try to escape with ..
        let result = sanitize_path(base, Path::new("../../etc/passwd"));
        assert!(result.is_err());

        // Valid subdirectory should work
        let subdir = base.join("subdir");
        fs::create_dir(&subdir).unwrap();
        let result = sanitize_path(base, Path::new("subdir"));
        assert!(result.is_ok());
    }
}
