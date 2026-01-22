# SyncWatcher - Phase 5 Implementation Plan

## 개요

Phase 3-4 문서에는 여러 기능이 **구현 완료**로 표시되어 있으나, 실제 코드 검토 결과 다음과 같은 상황입니다:

- **문서 상태**: Dashboard UI, Sidebar, Volume listing, Sync Tasks, Activity Log, Settings 등이 "UI exists" 또는 "created"로 표시
- **실제 상태**: `App.tsx`는 기본 Tauri 템플릿 그대로 유지됨 (Welcome to Tauri + React)
- **원인**: Phase 3-4에서 의존성 설치 및 설정은 완료했으나, TypeScript 컴파일 에러로 인해 실제 UI 구현은 롤백됨

## 미구현 항목 상세

### 1. Frontend UI Components (PHASE3-4_COMPLETION_STATUS.md에서 "created"로 표시됨)

#### Dashboard View

- **문서 상태**: "Dashboard view with Bento Grid layout ✅"
- **실제 상태**: ❌ 미구현
- **필요 작업**:
  - Bento Grid 레이아웃 구현
  - Volume listing 카드 컴포넌트
  - Sync progress 표시 위젯
  - Quick actions 버튼
  - 실시간 속도/용량 표시

#### Sidebar Navigation

- **문서 상태**: "Navigation sidebar with tabs ✅"
- **실제 상태**: ❌ 미구현
- **필요 작업**:
  - 좌측 사이드바 레이아웃
  - Dashboard / Sync Tasks / Activity Log / Settings 탭
  - 활성 탭 하이라이트
  - i18n 통합 (번역 적용)

#### Sync Tasks View

- **문서 상태**: "UI exists but no CRUD operations"
- **실제 상태**: ❌ UI 자체가 미구현
- **필요 작업**:
  - 태스크 목록 표시
  - 태스크 추가/수정/삭제 UI
  - 태스크 활성화/비활성화 토글
  - localStorage 또는 Tauri store 연동

#### Activity Log View

- **문서 상태**: "UI placeholder, no actual history storage"
- **실제 상태**: ❌ UI 자체가 미구현
- **필요 작업**:
  - 동기화 이력 목록 표시
  - 시간별 필터링
  - 성공/실패 상태 표시
  - 상세 정보 모달

#### Settings View

- **문서 상태**: "UI exists but no persistence"
- **실제 상태**: ❌ UI 자체가 미구현
- **필요 작업**:
  - 언어 선택 드롭다운 (5개 언어)
  - Dark mode 토글
  - 알림 설정
  - 자동 동기화 설정
  - 설정 저장/불러오기

### 2. Framer Motion Animations (PHASE3-4_COMPLETION_STATUS.md에서 "Not added yet")

- **문서 상태**: "Framer Motion: Not added yet"
- **실제 상태**: ✅ 패키지는 설치됨 (`package.json`에 v11.11.17)
- **필요 작업**:
  - 페이지 전환 애니메이션
  - Sync progress 애니메이션 (진행 바, 파일 리스트)
  - Activity 카드 등장 애니메이션
  - 호버/클릭 인터랙션 애니메이션

### 3. Folder Watcher Integration (PHASE3-4_COMPLETION_STATUS.md에서 "Not connected to UI yet")

- **문서 상태**: "Folder Watcher: Not connected to UI yet"
- **실제 상태**:
  - ✅ Rust backend에서 `FolderWatcher` 구현됨 (`system_integration.rs`)
  - ❌ Tauri command로 노출되지 않음
  - ❌ Frontend에서 이벤트 리스닝 안 됨
- **필요 작업**:
  - `start_folder_watch` Tauri command 추가
  - `folder-change` 이벤트 emit
  - Frontend에서 이벤트 리스닝 및 UI 업데이트

### 4. Error Handling (PHASE3-4_COMPLETION_STATUS.md에서 "Not implemented")

- **문서 상태**: "Error Handling: Not implemented"
- **실제 상태**: ❌ 미구현
- **필요 작업**:
  - 에러 토스트/알림 컴포넌트
  - 에러 로깅 (console.error + Tauri logging)
  - 네트워크 에러 처리
  - 권한 에러 처리
  - Disk full 에러 처리

### 5. State Management & Persistence

- **문서 상태**: 언급 없음 (localStorage 권장)
- **실제 상태**: ❌ 미구현
- **필요 작업**:
  - Sync Tasks 저장 (`list_sync_tasks` Tauri command 현재 빈 배열 반환)
  - Activity Log 저장
  - Settings 저장
  - 옵션:
    - localStorage (간단, 즉시 사용 가능)
    - `tauri-plugin-store` (Tauri 공식, Rust 파일 저장)

### 6. Mantine UI Integration

- **문서 상태**: "Mantine v8.3.13 installed ✅"
- **실제 상태**:
  - ✅ 패키지 설치됨
  - ✅ `MantineProvider` 설정됨 (`main.tsx`)
  - ❌ 실제로 사용되지 않음 (App.css만 사용)
- **필요 작업**:
  - Mantine 컴포넌트로 UI 구축 결정 필요
  - 또는 Tailwind CSS로 전면 구축 결정 필요
  - 두 라이브러리 혼용 시 스타일 충돌 주의

## 구현 우선순위

### Priority 1: Core UI (필수)

1. **Dashboard View** - 볼륨 리스트 및 동기화 트리거
2. **Sidebar Navigation** - 페이지 전환
3. **Sync Tasks View** - 태스크 CRUD

### Priority 2: Essential Features (중요)

4. **Activity Log** - 동기화 이력
2. **Settings** - 언어/설정 저장
3. **Error Handling** - 사용자 피드백

### Priority 3: Polish (선택)

7. **Framer Motion** - 애니메이션
2. **Folder Watcher UI** - 실시간 변경 감지 표시

## 기술 스택 결정 사항

### UI Framework 선택 (결정 필요)

**Option A: Mantine UI 사용**

- ✅ 이미 설치됨
- ✅ 컴포넌트 풍부함
- ⚠️ Phase 3에서 JSX 에러 발생 이력 (이미 해결됨)

**Option B: Tailwind CSS로 순수 구축**

- ✅ 이미 설정됨 (v4.1.18)
- ✅ 유연성 높음
- ⚠️ 컴포넌트 직접 구축 필요

**Option C: 혼용**

- Mantine: 복잡한 컴포넌트 (Select, Modal, Tabs)
- Tailwind: 레이아웃 및 커스텀 스타일

### State Management (권장)

- **로컬 상태**: React `useState` / `useReducer`
- **영구 저장**:
  - Sync Tasks: Tauri Store 또는 localStorage
  - Activity Log: SQLite (via Tauri) 또는 localStorage
  - Settings: localStorage

## 검증 계획

### 1. UI 렌더링 확인

```bash
npm run tauri dev
```

- Dashboard가 정상 표시되는지 확인
- Sidebar 탭 전환이 동작하는지 확인
- i18n 언어 전환이 동작하는지 확인

### 2. 기능 테스트

- Sync Tasks CRUD 동작 확인 (추가/수정/삭제/저장)
- Activity Log에 동기화 이력이 기록되는지 확인
- Settings가 저장되고 재시작 후 복원되는지 확인

### 3. Tauri Integration 테스트

- Volume listing이 Tauri command와 연동되는지 확인
- Sync 진행 시 progress 이벤트가 수신되는지 확인
- Folder watcher 이벤트가 UI에 반영되는지 확인

### 4. 수동 테스트 시나리오

1. 앱 실행 → Dashboard에서 볼륨 확인
2. Sync Tasks 탭 → 새 태스크 추가 → 동기화 실행
3. Activity Log 탭 → 이력 확인
4. Settings 탭 → 언어 변경 → UI 번역 확인
5. 앱 재시작 → 설정/태스크가 유지되는지 확인

## 다음 단계

1. **UI Framework 결정**: Mantine vs Tailwind vs 혼용
2. **Dashboard 구현**: Volume listing + Sync trigger
3. **Navigation 구현**: Sidebar + tab routing
4. **State Management**: Sync Tasks 저장 구조 설계
5. **점진적 구현**: Dashboard → Tasks → Activity → Settings

---

**참고**: Phase 3-4에서 준비한 모든 인프라(i18n, Tailwind, Mantine, Framer Motion)는 정상 작동하므로, 이제 실제 UI 컴포넌트 구현만 진행하면 됩니다.
