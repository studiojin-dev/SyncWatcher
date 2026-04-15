use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_build::build();

    #[cfg(target_os = "macos")]
    build_macos_bridge();
}

#[cfg(target_os = "macos")]
fn build_macos_bridge() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));
    let swift_file = PathBuf::from("macos").join("SyncWatcherMacBridge.swift");

    println!("cargo:rerun-if-changed={}", swift_file.display());

    let sdk_path_output = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .expect("failed to query macOS SDK path via xcrun");
    if !sdk_path_output.status.success() {
        panic!(
            "xcrun --show-sdk-path failed: {}",
            String::from_utf8_lossy(&sdk_path_output.stderr)
        );
    }
    let sdk_path = String::from_utf8(sdk_path_output.stdout)
        .expect("xcrun SDK path was not valid UTF-8")
        .trim()
        .to_string();
    let swift_runtime_library_paths = query_swift_runtime_library_paths();

    let target = env::var("TARGET").expect("TARGET must be set");
    let swift_target = if target.starts_with("aarch64-apple-darwin") {
        "arm64-apple-macosx12.0"
    } else if target.starts_with("x86_64-apple-darwin") {
        "x86_64-apple-macosx12.0"
    } else {
        panic!("Unsupported macOS target for Swift bridge: {target}");
    };

    let output_library = out_dir.join("libsyncwatcher_macos_bridge.a");
    let status = Command::new("xcrun")
        .args(["swiftc", "-parse-as-library"])
        .arg(&swift_file)
        .args([
            "-emit-library",
            "-static",
            "-module-name",
            "SyncWatcherMacBridge",
            "-target",
            swift_target,
            "-sdk",
        ])
        .arg(&sdk_path)
        .arg("-o")
        .arg(&output_library)
        .status()
        .expect("failed to build Swift bridge with xcrun swiftc");

    if !status.success() {
        panic!("Swift bridge build failed");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=syncwatcher_macos_bridge");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=NetFS");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=StoreKit");
    for runtime_path in swift_runtime_library_paths {
        println!("cargo:rustc-link-search=native={runtime_path}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{runtime_path}");
    }
}

#[cfg(target_os = "macos")]
fn query_swift_runtime_library_paths() -> Vec<String> {
    let target_info_output = Command::new("xcrun")
        .args(["swiftc", "-print-target-info"])
        .output()
        .expect("failed to query Swift target info via xcrun");
    if !target_info_output.status.success() {
        panic!(
            "xcrun swiftc -print-target-info failed: {}",
            String::from_utf8_lossy(&target_info_output.stderr)
        );
    }

    let target_info = String::from_utf8(target_info_output.stdout)
        .expect("Swift target info was not valid UTF-8");
    let mut paths = Vec::new();
    let mut in_runtime_paths = false;

    for line in target_info.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("\"runtimeLibraryPaths\"") {
            in_runtime_paths = true;
            continue;
        }
        if !in_runtime_paths {
            continue;
        }
        if trimmed.starts_with(']') {
            break;
        }
        if !trimmed.starts_with('"') {
            continue;
        }

        let remainder = &trimmed[1..];
        let Some(end_quote) = remainder.find('"') else {
            continue;
        };
        paths.push(remainder[..end_quote].to_string());
    }

    if paths.is_empty() {
        panic!("Swift runtime library paths were not found in xcrun target info");
    }

    paths
}
