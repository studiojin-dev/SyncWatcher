# Phase 6 Implementation - Advanced Features & Polish

## 개요

Phase 5에서 UI 기초가 완성되었습니다. Phase 6에서는 데이터 안정성, 사용자 경험 개선, 그리고 고급 기능을 구현합니다.

---

## 1. State Management & Persistence (데이터 안정성)

### 1-1. Config Directory 설정

- [ ] Settings에 "State Location" 설정 추가
- [ ] 기본값: Tauri AppData 디렉토리
- [ ] 사용자 지정 디렉토리 선택 기능 구현 (Tauri dialog)

### 1-2. YAML 기반 저장소

- [ ] `SyncStore` 로직 개선: JSON → YAML 포맷 변경
- [ ] `settings.yaml`: 앱 설정 저장
- [ ] `tasks.yaml`: 동기화 태스크 정의 저장
- [ ] 파일 변경 감지 및 자동 리로드 (외부 편집 지원)

---

## 2. Activity Log System Improvement (로그 시스템 개선)

### 2-1. 로그 구조 분리

- [ ] **System Logs (Global)**: 태스크 시작/종료, 에러, 앱 이벤트 (상단 메뉴의 Activity Log)
- [ ] **Sync Logs (Per Task)**: 파일 복사/삭제 상세 로그 (각 태스크 별도 뷰)
- [ ] 로그 파일 분리: `logs/system.log`, `logs/tasks/<task-id>.log`

### 2-2. Log Rotation & Management

- [ ] 기본 10,000줄 제한 구현 (Circular Buffer)
- [ ] Settings에서 최대 라인 수 설정 기능 추가
- [ ] 오래된 로그 자동 아카이빙 또는 삭제

---

## 3. Sync Task UX Improvements (사용자 경험 개선)

### 3-1. 디렉토리 선택 UI

- [ ] Source/Target 입력란 옆에 "폴더 찾기" 버튼 추가
- [ ] Tauri `dialog.open` API 연동

### 3-2. 도움말 및 안내 강화

- [ ] "Delete Missing", "Checksum Mode" 옆에 Tooltip(물음표 아이콘) 추가
- [ ] "Enabled" 버튼 명확화 → "Auto Watch" 또는 "Active"로 변경 및 툴팁 추가
- [ ] "Dry Run" 아이콘(눈) → "Preview" 텍스트 버튼으로 변경

### 3-3. Task Navigation

- [ ] Task Add/Edit 시 Full-screen Overlay 또는 별도 페이지로 전환 (Navigation Stack)

### 3-4. Watch Mode Control

- [ ] "Start Watching" / "Stop Watching" 명시적 컨트롤 추가
- [ ] 감시 중일 때 상태 표시기 (Spinning/Pulse indicator)

---

## 4. Settings Refactoring

### 4-1. Auto Sync 이동

- [ ] Global Settings의 "Auto Sync" 제거
- [ ] Sync Task별 "Auto Sync" (Watch Mode) 설정 확인
- [ ] verify_after_copy 구현 : 복사 후 checksum 을 한번 더 하는 기능으로 복사가 잘 되었는지 확인하는 기능. 단 시스템 부하가 커지므로 아주 중요한 데이터일 경우에만 하도록 툴팁 및 도움말 제공.
---

## 5. System Integration

### 5-1. Tray Icon & Background Logic

- [ ] System Tray 아이콘 추가
- [ ] "Hide to Tray" 기능
- [ ] Dock 아이콘 없이 백그라운드 실행 옵션 (MacOS specific)
- [ ] "Quit" 메뉴 추가


## 6. 도움말 페이지

사이드카 메뉴에 추가

- [ ] 이 프로그램이 제공하는 기능 설명
- [ ] Sync Task별 속성에 따라 동작하는 방식 설명

## 7. OpenSource , 버전, Copyright 표시

사이드카 메뉴에 추가

- [ ] 개발자 이름, 버전 표시
- [ ] 사용된 OpenSource 라이브러리 수집하여 문서화 하는 명령어 추가
- [ ] OpenSource 문서 표시 화면

---

## Phase 5 미완료 항목 확인

- [ ] `FolderWatcher` UI 연동 (Phase 6 3-4 항목에 포함됨)
- [ ] Error Handling UI 고도화 (Toast 외 상세 모달 등)
