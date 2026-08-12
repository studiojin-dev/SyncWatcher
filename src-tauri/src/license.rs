use tauri::Manager;

#[tauri::command]
pub async fn generate_licenses_report(app: tauri::AppHandle) -> Result<String, String> {
    let report = r#"# Open Source Licenses

SyncWatcher source code is licensed under Apache-2.0. Third-party packages keep
their own copyright notices and license terms.

The application bundle contains the complete Rust dependency inventory and
license texts in `THIRD_PARTY_LICENSES.html`. The frontend inventory and its
license/notice texts are available from About > Open Source Licenses and in the
production-build artifact `oss-licenses.json`.

Project-level notices are bundled as `LICENSE`, `NOTICE`, `TRADEMARKS.md`, and
`BRAND_ASSETS.md`.
"#;

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let report_path = app_data.join("licenses.md");
    tokio::fs::write(&report_path, report)
        .await
        .map_err(|e| e.to_string())?;

    Ok(report_path.to_string_lossy().to_string())
}
