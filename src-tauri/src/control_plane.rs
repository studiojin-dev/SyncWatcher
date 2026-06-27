use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio_util::sync::CancellationToken;

use crate::config_store::default_control_plane_socket_path;

pub(crate) const MAX_CONTROL_PLANE_REQUEST_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneRequest {
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneResponse {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<ControlPlaneError>,
}

impl ControlPlaneResponse {
    pub fn ok(request_id: impl Into<String>, result: serde_json::Value) -> Self {
        Self {
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            ok: false,
            result: None,
            error: Some(ControlPlaneError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ControlPlaneHandle {
    pub socket_path: PathBuf,
    pub shutdown: CancellationToken,
}

pub fn default_socket_path() -> Result<PathBuf, String> {
    default_control_plane_socket_path().map_err(|error| error.to_tauri_error_string())
}

pub async fn send_request(
    socket_path: &Path,
    request: &ControlPlaneRequest,
) -> Result<ControlPlaneResponse, String> {
    let mut stream = tokio::net::UnixStream::connect(socket_path)
        .await
        .map_err(|error| format!("Failed to connect to '{}': {error}", socket_path.display()))?;

    let payload = serde_json::to_vec(request)
        .map_err(|error| format!("Failed to encode request: {error}"))?;
    stream
        .write_all(&payload)
        .await
        .map_err(|error| format!("Failed to write request: {error}"))?;
    stream
        .shutdown()
        .await
        .map_err(|error| format!("Failed to finish request: {error}"))?;

    let mut response_bytes = Vec::new();
    stream
        .read_to_end(&mut response_bytes)
        .await
        .map_err(|error| format!("Failed to read response: {error}"))?;

    serde_json::from_slice(&response_bytes)
        .map_err(|error| format!("Failed to decode response: {error}"))
}

pub async fn start_listener<F, Fut>(
    socket_path: PathBuf,
    handler: F,
) -> Result<ControlPlaneHandle, String>
where
    F: Fn(ControlPlaneRequest) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ControlPlaneResponse> + Send + 'static,
{
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create '{}': {error}", parent.display()))?;
    }

    if socket_path.exists() {
        let _ = tokio::fs::remove_file(&socket_path).await;
    }

    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("Failed to bind '{}': {error}", socket_path.display()))?;
    let shutdown = CancellationToken::new();
    let shutdown_for_task = shutdown.clone();
    let socket_path_for_task = socket_path.clone();
    let handler = Arc::new(handler);

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_for_task.cancelled() => {
                    break;
                }
                accept_result = listener.accept() => {
                    let Ok((mut stream, _addr)) = accept_result else {
                        continue;
                    };
                    let handler = Arc::clone(&handler);
                    tauri::async_runtime::spawn(async move {
                        let response = match read_request_bytes(&mut stream).await {
                            Ok(request_bytes) => match serde_json::from_slice::<ControlPlaneRequest>(&request_bytes) {
                                Ok(request) => handler(request).await,
                                Err(error) => ControlPlaneResponse::error(
                                    "unknown",
                                    "invalid_request",
                                    format!("Failed to parse request: {error}"),
                                ),
                            },
                            Err(response) => response,
                        };

                        if let Ok(payload) = serde_json::to_vec(&response) {
                            let _ = stream.write_all(&payload).await;
                        }
                        let _ = stream.shutdown().await;
                    });
                }
            }
        }

        let _ = tokio::fs::remove_file(&socket_path_for_task).await;
    });

    Ok(ControlPlaneHandle {
        socket_path,
        shutdown,
    })
}

async fn read_request_bytes<R>(reader: &mut R) -> Result<Vec<u8>, ControlPlaneResponse>
where
    R: AsyncRead + Unpin,
{
    let mut request_bytes = Vec::new();
    let mut limited_reader = reader.take((MAX_CONTROL_PLANE_REQUEST_BYTES + 1) as u64);
    limited_reader
        .read_to_end(&mut request_bytes)
        .await
        .map_err(|error| {
            ControlPlaneResponse::error(
                "unknown",
                "io_error",
                format!("Failed to read request: {error}"),
            )
        })?;

    if request_bytes.len() > MAX_CONTROL_PLANE_REQUEST_BYTES {
        return Err(ControlPlaneResponse::error(
            "unknown",
            "invalid_request",
            format!(
                "Request too large: max {} bytes",
                MAX_CONTROL_PLANE_REQUEST_BYTES
            ),
        ));
    }

    Ok(request_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_request_bytes_accepts_small_payload() {
        let mut reader = tokio::io::repeat(b'a').take(8);
        let bytes = read_request_bytes(&mut reader)
            .await
            .expect("small payload should read");
        assert_eq!(bytes, vec![b'a'; 8]);
    }

    #[tokio::test]
    async fn read_request_bytes_rejects_oversized_payload_before_parse() {
        let mut reader = tokio::io::repeat(b'a').take((MAX_CONTROL_PLANE_REQUEST_BYTES + 1) as u64);
        let response = read_request_bytes(&mut reader)
            .await
            .expect_err("oversized payload should be rejected");

        assert_eq!(response.request_id, "unknown");
        assert!(!response.ok);
        let error = response.error.expect("error should be present");
        assert_eq!(error.code, "invalid_request");
        assert!(error.message.contains("Request too large"));
    }
}
