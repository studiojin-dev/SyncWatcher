use clap::Parser;
use indicatif::{ProgressBar, ProgressStyle};
use std::path::PathBuf;

use syncwatcher_lib::sync_engine::{FileDiffKind, SyncEngine, SyncOptions};

#[derive(Parser)]
#[command(name = "sync-cli")]
#[command(about = "File synchronization CLI", long_about = None)]
struct Cli {
    #[arg(short, long)]
    source: Option<PathBuf>,

    #[arg(short, long)]
    target: Option<PathBuf>,

    #[arg(short = 'n', long)]
    dry_run: bool,

    #[arg(short = 'd', long)]
    delete_missing: bool,

    #[arg(short = 'c', long)]
    no_checksum: bool,

    #[arg(long)]
    list_volumes: bool,

    #[arg(long)]
    verify: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    if cli.list_volumes {
        use syncwatcher_lib::system_integration::DiskMonitor;

        println!("💾 Scanning for volumes...");
        let monitor = DiskMonitor::new();
        match monitor.list_volumes() {
            Ok(volumes) => {
                println!("Found {} volume(s):", volumes.len());
                println!(
                    "{:<20} {:<15} {:<15} {:<15}",
                    "NAME", "TOTAL", "AVAILABLE", "TYPE"
                );
                println!("{}", "-".repeat(65));

                for vol in volumes {
                    let type_str = if vol.is_removable {
                        "Removable"
                    } else {
                        "Fixed"
                    };
                    let total_gb = vol.total_bytes as f64 / 1_073_741_824.0;
                    let avail_gb = vol.available_bytes as f64 / 1_073_741_824.0;

                    println!(
                        "{:<20} {:<15.2} {:<15.2} {:<15}",
                        vol.name,
                        format!("{:.2} GB", total_gb),
                        format!("{:.2} GB", avail_gb),
                        type_str
                    );
                }
            }
            Err(e) => anyhow::bail!("Failed to list volumes: {e}"),
        }
        return Ok(());
    }

    let source = cli
        .source
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: --source"))?;
    let target = cli
        .target
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: --target"))?;

    if !source.exists() {
        anyhow::bail!("Source directory does not exist: {source:?}");
    }

    let engine = SyncEngine::new(source.clone(), target.clone());

    let options = SyncOptions {
        delete_missing: cli.delete_missing,
        checksum_mode: !cli.no_checksum,
        preserve_permissions: true,
        preserve_times: true,
        verify_after_copy: cli.verify,
        exclude_patterns: Vec::new(),
    };

    if cli.dry_run {
        println!("🔍 Dry-run mode - comparing directories...");
        println!("   Source: {source:?}");
        println!("   Target: {target:?}");
        println!();

        match engine.dry_run(&options).await {
            Ok(dry_run) => {
                println!("📊 Comparison Results:");
                println!("   Total files in source: {}", dry_run.total_files);
                println!("   Files to copy: {}", dry_run.files_to_copy);
                println!("   Files modified: {}", dry_run.files_modified);
                println!("   Files to delete: {}", dry_run.files_to_delete);
                println!("   Bytes to copy: {} MB", dry_run.bytes_to_copy / 1_048_576);
                println!();

                if !dry_run.diffs.is_empty() {
                    println!("📝 Detailed Differences:");
                    for diff in &dry_run.diffs {
                        let icon = match diff.kind {
                            FileDiffKind::New => "➕",
                            FileDiffKind::Modified => "🔄",
                            FileDiffKind::Deleted => "❌",
                        };
                        let action = match diff.kind {
                            FileDiffKind::New => "NEW",
                            FileDiffKind::Modified => "MODIFIED",
                            FileDiffKind::Deleted => "DELETE",
                        };
                        println!(
                            "   {} {:?} - {} ({} bytes)",
                            icon,
                            diff.path,
                            action,
                            diff.source_size.unwrap_or(0)
                        );
                    }
                } else {
                    println!("✅ Directories are in sync!");
                }
            }
            Err(e) => {
                eprintln!("❌ Error during dry-run: {e}");
                std::process::exit(1);
            }
        }
    } else {
        println!("🚀 Starting synchronization...");
        println!("   Source: {source:?}");
        println!("   Target: {target:?}");
        println!("   Delete missing: {}", cli.delete_missing);
        println!("   Checksum mode: {}", options.checksum_mode);
        println!();

        let dry_run = engine.dry_run(&options).await?;
        let total_bytes = dry_run.bytes_to_copy;

        if total_bytes == 0 && dry_run.files_to_delete == 0 {
            println!("✅ Nothing to synchronize!");
            return Ok(());
        }

        let pb = ProgressBar::new(total_bytes);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({eta})")?
                .progress_chars("#>-"),
        );
        pb.set_message("Synchronizing...");

        match engine
            .sync_files(&options, |progress| {
                pb.set_length(progress.total_bytes);
                pb.set_position(progress.processed_bytes);

                if let Some(file) = progress.current_file {
                    pb.set_message(format!("{:?} - {}", progress.phase, file));
                } else {
                    pb.set_message(format!("{:?}", progress.phase));
                }
            })
            .await
        {
            Ok(result) => {
                pb.finish_with_message("✅ Synchronization complete!");
                println!();
                println!("📊 Results:");
                println!("   Files copied: {}", result.files_copied);
                println!("   Files deleted: {}", result.files_deleted);
                println!("   Bytes copied: {} MB", result.bytes_copied / 1_048_576);
                if !result.errors.is_empty() {
                    println!("   Errors: {}", result.errors.len());
                    for error in &result.errors {
                        let kind_str = match error.kind {
                            syncwatcher_lib::sync_engine::types::SyncErrorKind::CopyFailed => "Copy Failed",
                            syncwatcher_lib::sync_engine::types::SyncErrorKind::DeleteFailed => "Delete Failed",
                            syncwatcher_lib::sync_engine::types::SyncErrorKind::VerificationFailed => "Verification Failed",
                            syncwatcher_lib::sync_engine::types::SyncErrorKind::Other => "Error",
                        };
                        eprintln!("   ⚠️  [{}] {:?}: {}", kind_str, error.path, error.message);
                    }
                }
            }
            Err(e) => {
                pb.abandon_with_message("❌ Synchronization failed!");
                eprintln!("❌ Error: {e}");
                std::process::exit(1);
            }
        }
    }

    Ok(())
}
