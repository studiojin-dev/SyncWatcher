#!/bin/bash
set -e  # Exit on error

echo "=== SyncWatcher Verification Script ==="
echo

# 0. Run Unit Tests first
echo "0. Running Cargo Tests..."
cd src-tauri
cargo test
cd ..

echo "1. Creating test directories..."
rm -rf /tmp/sync-test # Clean up previous run
mkdir -p /tmp/sync-test/source/subdir
mkdir -p /tmp/sync-test/target

echo "2. Creating test files..."
echo "Hello from SyncWatcher!" > /tmp/sync-test/source/readme.txt
echo "This is test file 1" > /tmp/sync-test/source/file1.txt
echo "This is test file 2" > /tmp/sync-test/source/file2.txt
echo "Subdirectory file" > /tmp/sync-test/source/subdir/nested.txt

echo "3. Running dry-run..."
./src-tauri/target/release/sync-cli \
  --source /tmp/sync-test/source \
  --target /tmp/sync-test/target \
  --dry-run

echo
echo "4. Running full sync with verification..."
./src-tauri/target/release/sync-cli \
  --source /tmp/sync-test/source \
  --target /tmp/sync-test/target \
  --verify

echo
echo "5. Verifying synced files..."
echo "Target directory contents:"
ls -lah /tmp/sync-test/target/

echo
echo "6. Modifying a file and testing diff detection..."
echo "Modified content!" > /tmp/sync-test/source/file1.txt

./src-tauri/target/release/sync-cli \
  --source /tmp/sync-test/source \
  --target /tmp/sync-test/target \
  --dry-run

echo
echo "7. Deleting source file and testing delete detection..."
rm /tmp/sync-test/source/file2.txt

./src-tauri/target/release/sync-cli \
  --source /tmp/sync-test/source \
  --target /tmp/sync-test/target \
  --dry-run \
  --delete-missing

echo
echo "8. Testing volume listing..."
./src-tauri/target/release/sync-cli --list-volumes

echo "✅ Verification complete!"
echo
echo "To test Tauri integration, run: npm run tauri dev"
