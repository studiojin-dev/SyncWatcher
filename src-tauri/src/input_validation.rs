//! Comprehensive input validation and sanitization
//!
//! Provides validation functions for user inputs to prevent security issues
//! including command injection, path traversal, and resource exhaustion.

use anyhow::{Result, bail};

/// Validate and sanitize exclude patterns
///
/// Ensures patterns are safe, properly formatted, and within reasonable limits.
pub fn validate_exclude_patterns(patterns: &[String]) -> Result<()> {
    const MAX_PATTERNS: usize = 100;
    const MAX_PATTERN_LENGTH: usize = 255;

    if patterns.len() > MAX_PATTERNS {
        bail!(
            "Too many exclusion patterns: {} (max: {})",
            patterns.len(),
            MAX_PATTERNS
        );
    }

    for pattern in patterns {
        let trimmed = pattern.trim();

        if trimmed.is_empty() {
            continue;
        }

        if trimmed.len() > MAX_PATTERN_LENGTH {
            bail!(
                "Pattern too long: '{}' ({} chars, max: {})",
                &trimmed[..20.min(trimmed.len())],
                trimmed.len(),
                MAX_PATTERN_LENGTH
            );
        }

        // Check for dangerous patterns
        if trimmed.contains("..") {
            bail!("Pattern contains path traversal: '{}'", trimmed);
        }

        if trimmed.contains('\0') || trimmed.contains('\n') || trimmed.contains('\r') {
            bail!("Pattern contains control characters");
        }

        // Validate glob syntax
        globset::Glob::new(trimmed).map_err(|e| {
            anyhow::anyhow!("Invalid glob pattern '{}': {}", trimmed, e)
        })?;
    }

    Ok(())
}

/// Validate and sanitize task ID
///
/// Ensures task IDs are safe and well-formed.
pub fn validate_task_id(task_id: &str) -> Result<()> {
    const MAX_TASK_ID_LENGTH: usize = 100;

    if task_id.is_empty() {
        bail!("Task ID cannot be empty");
    }

    if task_id.len() > MAX_TASK_ID_LENGTH {
        bail!(
            "Task ID too long: {} chars (max: {})",
            task_id.len(),
            MAX_TASK_ID_LENGTH
        );
    }

    // Only allow alphanumeric, hyphen, underscore
    if !task_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        bail!("Task ID contains invalid characters: '{}'", task_id);
    }

    Ok(())
}

/// Validate and sanitize path arguments
///
/// Uses existing path_validation module for comprehensive checks.
pub fn validate_path_argument(path: &str) -> Result<()> {
    // Length check
    if path.len() > 4096 {
        bail!("Path too long: {} bytes (max: 4096)", path.len());
    }

    // Null byte check
    if path.contains('\0') {
        bail!("Path contains null byte");
    }

    // Check for shell metacharacters that could be dangerous
    if path.contains('|') || path.contains('&') || path.contains(';')
        || path.contains('$') || path.contains('`') || path.contains('\n')
    {
        bail!("Path contains shell metacharacters");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_exclude_patterns_valid() {
        let patterns = vec![
            "*.log".to_string(),
            "node_modules/**".to_string(),
            ".git".to_string(),
        ];
        assert!(validate_exclude_patterns(&patterns).is_ok());
    }

    #[test]
    fn test_validate_exclude_patterns_too_many() {
        let patterns: Vec<String> = (0..101).map(|i| format!("pattern_{}", i)).collect();
        assert!(validate_exclude_patterns(&patterns).is_err());
    }

    #[test]
    fn test_validate_exclude_patterns_traversal() {
        let patterns = vec!["../../etc/passwd".to_string()];
        let result = validate_exclude_patterns(&patterns);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("path traversal"));
    }

    #[test]
    fn test_validate_exclude_patterns_null_byte() {
        let patterns = vec!["test\0file".to_string()];
        let result = validate_exclude_patterns(&patterns);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_exclude_patterns_empty() {
        let patterns = vec!["".to_string(), "  ".to_string()];
        assert!(validate_exclude_patterns(&patterns).is_ok()); // Empty patterns are skipped
    }

    #[test]
    fn test_validate_task_id_valid() {
        assert!(validate_task_id("task-123").is_ok());
        assert!(validate_task_id("my_task").is_ok());
        assert!(validate_task_id("TASK_123-456").is_ok());
    }

    #[test]
    fn test_validate_task_id_invalid() {
        assert!(validate_task_id("task with spaces").is_err());
        assert!(validate_task_id("task/123").is_err());
        assert!(validate_task_id("task;rm -rf /").is_err());
        assert!(validate_task_id("").is_err());
    }

    #[test]
    fn test_validate_task_id_too_long() {
        let long_id = "a".repeat(101);
        assert!(validate_task_id(&long_id).is_err());
    }

    #[test]
    fn test_validate_path_argument_valid() {
        assert!(validate_path_argument("/Users/test/file.txt").is_ok());
        assert!(validate_path_argument("/Volumes/USB").is_ok());
    }

    #[test]
    fn test_validate_path_argument_invalid() {
        assert!(validate_path_argument("/path\0with\0null").is_err());
        assert!(validate_path_argument("/path | rm -rf /").is_err());
        assert!(validate_path_argument("/path; echo bad").is_err());
        assert!(validate_path_argument("/path`whoami`").is_err());
        assert!(validate_path_argument("/path$HOME").is_err());
    }

    #[test]
    fn test_validate_path_argument_too_long() {
        let long_path = "/".repeat(5000);
        assert!(validate_path_argument(&long_path).is_err());
    }
}
