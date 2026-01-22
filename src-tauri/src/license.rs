use tauri::Manager;

#[tauri::command]
pub async fn generate_licenses_report(app: tauri::AppHandle) -> Result<String, String> {
    let report = r#"# Open Source Licenses

## Backend (Rust)
- Tauri 2.0.0 - https://github.com/tauri-apps/tauri (MIT/Apache-2.0)
- Tokio 1.40.0 - https://tokio.rs (MIT)
- serde 1.0.215 - https://serde.rs (MIT/Apache-2.0)
- serde_yaml 0.9.34 - https://github.com/dtolnay/serde-yaml (MIT/Apache-2.0)
- xxHash 1.6.0 - https://github.com/Cyan4973/xxHash (BSD-2)
- notify 6.1.0 - https://github.com/notify-rs/notify (MIT)

## Frontend (TypeScript/React)
- React 18.3.1 - https://react.dev (MIT)
- Mantine 8.3.13 - https://mantine.dev (MIT)
- Tabler Icons 3.22.0 - https://tabler-icons.io (MIT)
- i18next 24.0.2 - https://www.i18next.com (MIT)
- Framer Motion 11.11.17 - https://www.framer.com/motion (MIT)
- js-yaml 4.1.1 - https://github.com/nodeca/js-yaml (MIT)

## Development Tools
- TypeScript 5.6.2 - https://www.typescriptlang.org (Apache-2.0)
- Vite 6.0.3 - https://vitejs.dev (MIT)
- Tailwind CSS 4.1.18 - https://tailwindcss.com (MIT)

## License Summary

This project uses open-source software licensed under permissive terms (MIT, Apache-2.0, BSD-2).
All libraries are free to use, modify, and distribute.

For detailed license information, please see the project repository.
"#;

    let app_data = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let report_path = app_data.join("licenses.md");
    tokio::fs::write(&report_path, report)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(report_path.to_string_lossy().to_string())
}
