# MCP 제어 가이드

SyncWatcher는 실행 중인 앱을 조회하거나 제어하려는 클라이언트를 위해 로컬 MCP 제어 기능을 제공합니다.

이 문서는 MCP relay가 어떤 방식으로 동작하는지, 어떤 기능을 노출하는지, 그리고 의도적으로 제외한 범위를 설명합니다.

## MCP 동작 방식

SyncWatcher는 MCP relay 내부에서 직접 동기화 엔진을 실행하지 않습니다.

대신 설치된 `syncwatcher` 실행 파일을 아래처럼 실행할 수 있습니다.

```bash
syncwatcher --mcp-stdio --mcp-token <token>
```

이 stdio 프로세스는 얇은 relay 역할만 합니다. MCP tool 호출을 로컬 Unix socket을 통해 이미 실행 중인 SyncWatcher 앱으로 전달합니다.

중요한 동작 원칙은 다음과 같습니다.

- MCP는 기본적으로 비활성화되어 있습니다.
- 앱이 이미 실행 중이어야 합니다.
- 토큰이 없으면 SyncWatcher가 앱 실행 중에 MCP 인증 토큰을 자동 생성하고 계속 저장합니다.
- SyncWatcher는 MCP 때문에 스스로 자동 실행되지 않습니다.
- 실제 동기화 실행, 런타임 상태, 설정 저장은 모두 실행 중인 앱 백엔드가 담당합니다.
- 모든 MCP 요청에는 현재 토큰이 포함되어야 합니다. SyncWatcher에서 토큰을 재생성하면 기존 클라이언트 설정은 즉시 동작하지 않습니다.

## 연결 전에 해야 할 일

1. SyncWatcher를 일반 방식으로 실행합니다.
2. `Settings`를 엽니다.
3. `MCP 제어 허용`을 켭니다.
4. `Settings` 또는 `Help -> MCP 제어`에서 MCP 클라이언트 설정 예제를 복사합니다.
5. MCP 클라이언트의 command를 설치된 SyncWatcher 실행 파일로 지정합니다.
6. 인자로 `--mcp-stdio`와 `--mcp-token <현재 토큰>`을 함께 전달합니다.

MCP가 비활성화된 상태라면, tool 호출은 먼저 MCP 제어를 켜라는 안내가 포함된 오류를 반환합니다.

MCP가 활성화되어 있어도 앱이 실행 중이 아니면, 앱을 수동으로 먼저 실행하라는 안내 오류를 반환합니다.

## 제공하는 Tool

SyncWatcher MCP v1은 총 14개의 tool을 제공합니다.

### 설정

- `syncwatcher_get_settings`
- `syncwatcher_update_settings`

MCP로 변경 가능한 설정은 의도적으로 아래 항목으로 제한됩니다.

- `language`
- `theme`
- `dataUnitSystem`
- `notifications`
- `closeAction`
- `mcpEnabled`

`isRegistered` 같은 읽기 전용 필드는 settings snapshot에 포함되어 반환될 수 있습니다.

### SyncTask 관리

- `syncwatcher_list_sync_tasks`
- `syncwatcher_get_sync_task`
- `syncwatcher_create_sync_task`
- `syncwatcher_update_sync_task`
- `syncwatcher_delete_sync_task`

Task payload는 앱 백엔드가 사용하는 필드를 그대로 따르며, 대표적으로 아래 항목을 포함합니다.

- name
- source
- target
- checksumMode
- verifyAfterCopy
- exclusionSets
- watchMode
- autoUnmount
- sourceType
- sourceUuid
- sourceUuidType
- sourceSubPath
- recurringSchedules

task id는 생성 시 백엔드가 할당합니다.

### 장기 실행 작업

- `syncwatcher_start_dry_run`
- `syncwatcher_start_sync`
- `syncwatcher_start_orphan_scan`

이 tool들은 완료까지 대기하지 않고 `jobId`를 반환합니다.

### Job 제어

- `syncwatcher_get_job`
- `syncwatcher_cancel_job`

`syncwatcher_get_job`은 다음 정보를 반환합니다.

- `jobId`
- `kind`
- `taskId`
- `status`
- `progress`
- `result`
- `error`
- `createdAtUnixMs`
- `updatedAtUnixMs`

job 상태 값은 아래 다섯 가지입니다.

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

### 런타임 / 환경 조회

- `syncwatcher_get_runtime_state`
- `syncwatcher_list_removable_volumes`

`syncwatcher_get_runtime_state`는 아래 배열을 반환합니다.

- `watchingTasks`
- `syncingTasks`
- `queuedTasks`

`syncwatcher_list_removable_volumes`는 현재 실행 중인 앱이 인식한 이동식 볼륨 목록을 반환하며, 경로, 용량, UUID, serial, bus protocol 같은 식별 메타데이터를 포함할 수 있습니다.

## 결과 구조

### Dry Run

완료된 dry-run job의 결과에는 아래 필드가 들어갑니다.

- `diffs`
- `total_files`
- `files_to_copy`
- `files_modified`
- `bytes_to_copy`
- `targetPreflight`

각 diff 항목은 아래 정보를 가집니다.

- `path`
- `kind`
- `source_size`
- `target_size`
- `checksum_source`
- `checksum_target`

### Sync

완료된 sync job의 결과 envelope에는 아래 필드가 들어갑니다.

- `conflictCount`
- `conflictSessionId`
- `hasPendingConflicts`
- `syncResult`
- `targetPreflight`

그 안의 `syncResult`에는 현재 아래 필드가 포함됩니다.

- `files_copied`
- `bytes_copied`
- `errors`

### Orphan Scan

완료된 orphan-scan job은 아래 필드를 가진 orphan 항목 배열을 반환합니다.

- `path`
- `size`
- `is_dir`

## MCP에서 제공하지 않는 것

MCP v1은 아래 기능을 의도적으로 제공하지 않습니다.

- orphan 삭제
- conflict resolution 액션
- 직접 unmount 제어
- 라이선스 활성화 및 라이선스 관리 액션
- 앱 자동 실행
- `stateLocation` 쓰기
- `maxLogLines` 쓰기

이 제한은 의도된 설계입니다. MCP는 실행 중인 앱을 더 좁은 신뢰 경계 안에서 제어하기 위한 것이지, 기존 UI 안전 절차를 우회하기 위한 것이 아닙니다.

## 운영 메모

- 오래 걸리는 작업은 `syncwatcher_get_job`으로 polling 해야 합니다.
- MCP relay는 로컬 전용이며 stdio와 로컬 Unix socket을 사용합니다.
- SyncWatcher UI와 MCP는 같은 백엔드 설정/런타임 경로를 공유하므로, MCP로 시작한 작업도 UI에서 시작한 작업과 같은 검증과 안전 제약을 따릅니다.
