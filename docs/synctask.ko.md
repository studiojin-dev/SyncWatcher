# SyncTask Guide

SyncTask는 SyncWatcher 안에서 반복 사용하는 백업 작업 단위입니다. Source, Target, 그리고 복사 동작 방식을 함께 저장합니다.

## 대시보드

![SyncTask dashboard](../manual/SCR-20260324-1.png)

대시보드는 사용자가 가장 먼저 보게 되는 화면으로, 작업 상태와 진행 상황, 빠른 제어 버튼을 한 곳에서 보여줍니다.

## 작업 추가 / 편집

![SyncTask editor](../manual/SCR-20260324-synctask-0.png)

Source, Target, 동작 옵션을 선택해서 새 SyncTask를 만들거나 기존 작업을 수정할 수 있습니다.

![SyncTask editor detail](../manual/SCR-20260324-synctask-1.png)

반복되는 작업 흐름을 빠르게 조정할 수 있도록 주요 설정을 한 화면에 모아둡니다.

## 이동식 저장장치 대상

![External storage selection](../manual/SCR-20260324-synctask-2-external-storage.png)

SD 카드 같은 이동식 디스크를 Target으로 선택할 수 있습니다. `watchmode`와 조합하면 자동 복사 후 자동 꺼내기 흐름에도 맞출 수 있습니다.

## 체크섬 모드

![Checksum mode](../manual/SCR-20260324-synctask-3-checksum.png)

체크섬 모드는 속도보다 복사 후 검증이 더 중요한 경우에 사용합니다. 복사 완료 후 다시 검사해서 결과 신뢰도를 높입니다.

## Watch Mode

![Watch mode](../manual/SCR-20260324-synctask-4-watchmode.png)

`watchmode`를 켜면 Source 폴더 변경을 감지할 때마다 SyncWatcher가 자동으로 새 복사 작업을 시작합니다.

## 제외할 파일 유형

![Exclude file types](../manual/SCR-20260324-synctask-5-excluset.png)

복사에서 제외할 파일 유형을 선택할 수 있습니다. 추가 패턴은 `Settings`에서 등록할 수 있습니다.

## Task 카드 제어

![SyncTask card guide](../manual/SCR-20260324-synctask-card.png)

1. 체크섬 모드 표시
2. `watchmode` 활성화 표시
3. `autounmount` 모드 표시
4. 복사 없이 미리 확인하는 `dry-run` 버튼
5. 수동 복사 실행 버튼
6. `watchmode` 토글 버튼
7. Target에만 남아 있는 항목을 찾는 삭제 항목 탐색 기능
