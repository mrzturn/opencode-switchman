# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | **한국어** | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **zcode도 함께 사용 중이신가요?** 같은 저자의 자매 오픈소스 프로젝트 [zcode-switchman](https://github.com/mrzturn/zcode-switchman)을 확인해 보세요 — zcode 사용자에게 동일한 오케스트레이션을 제공합니다.

> 컨텍스트는 계기판으로 관리하고, 작업은 스스로 디스패치합니다.

![opencode-switchman — 컨텍스트 수위가 switchman을 움직이고 경로를 전환합니다](docs/assets/hero.svg)

> 인터랙티브 데모: [opencode-switchman in action](https://mrzturn.github.io/opencode-switchman/)

[OpenCode](https://opencode.ai)용 오케스트레이션 플러그인입니다. 두 가지 일을 하며, 둘 다 잘 해냅니다:

**1. 컨텍스트 수위 제어.** 세션의 컨텍스트를 매 턴 측정합니다. 읽기는 턴별 예산 안에서 수행되므로 모델이 몰래 리포지토리 전체를 들이켤 수 없고, soft / hard / force 수위선이 순서대로 조언 → 마무리 → 자동 백업·압축 핸드오버를 트리거합니다. 디스패치되는 모든 서브에이전트에도 각자의 하드 상한이 부여됩니다. 컨텍스트는 더 이상 눈덩이처럼 불어나지 않습니다 — 세션이 하루 종일 돌아도 토큰이 자기 히스토리에 잡아먹히는 일이 없습니다.

**2. 자동 의사결정 디스패칭.** 메인 모델이 디스패처로 변신합니다: 각 작업의 성격을 분석해 6개 인지 레인(economy / mechanical / main / hard / vision / review)의 서브에이전트 셸에 위임합니다. 플러그인은 결정론적 게이트와 가중치 기반 모델 스코어링, 자가 치유형 장애 격리를 강제하고 모든 라우팅 결정을 기록합니다.

여기에 더해:

- **모델·구독이 여러 개? 바로 그 상황을 위해 만들어진 플러그인.** GitHub Copilot, GLM Coding Plan, DeepSeek — 그 밖의 모든 opencode 프로바이더까지 — 하나의 풀로 묶어 오케스트레이션: 할당량 인지 정렬, 피크 시간대 회피, 교차 계열 리뷰 강제.
- **모델이 하나뿐이라도? 여전히 가치 있음.** 컨텍스트 제어와 스마트 디스패치만으로 단일 모델도 무기한 사용 가능 — 세션이 아무리 길어져도 컨텍스트는 부풀지 않음.

## 설치

명령 한 줄 — 최초 설치와 이후 업데이트를 모두 처리합니다. 실행 후 opencode를 재시작하세요.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

또는

```bash
npx -y opencode-switchman@latest
```

또는

```bash
bunx opencode-switchman@latest
```

어느 경로든 opencode 설정의 `plugin` 항목을 정확한 최신 버전으로 재작성하고 오래된 캐시를 정리합니다. 수동 npm 설치, 소스에서 직접 빌드, "왜 정확한 버전으로 고정하는가" 노트: [설치 상세](./docs/reference.md#installation).

손대기 싫다면? 설치를 AI에게 맡기세요 — 사용 중인 AI에 이 프롬프트를 붙여넣으세요:

<details open>
<summary><strong>AI 설치 위임 프롬프트</strong></summary>

```text
제 opencode에 opencode-switchman 플러그인을 설치·설정해 주세요. 공식 안내를 엄격히 따라 주세요.

공식 출처 (권위 있는 자료입니다. 기억으로 추측하지 말 것):
- GitHub 저장소: https://github.com/mrzturn/opencode-switchman
- npm 패키지: https://www.npmjs.com/package/opencode-switchman
저장소 README의 "Installation" 섹션을 읽고 그대로 따르세요.

단계:
1. npm에 게시된 최신 버전 설치: `npx -y opencode-switchman@latest`(또는 `bunx opencode-switchman@latest`) 실행 — 제 opencode 설정의 `plugin` 항목을 정확한 최신 버전으로 재작성합니다(제가 프로젝트 수준 `opencode.json`을 사용한다면 거기에서도 동일하게 동작함).
2. 기능 설정 완료: 플러그인 설정은 전부 제 opencode 설정 디렉터리의 단독 파일 `opencode-switchman.jsonc`에 들어 있으며, 첫 시작 시 기본값과 인라인 주석이 포함된 채 자동 생성됩니다. 제 프로바이더(예: `zhipuai-coding-plan` / `deepseek` / `github-copilot`)에 맞는지 확인하고 필요한 만큼 조정하세요.
3. opencode가 플러그인을 로드·기동·실행하는지 검증: opencode 안에서 `/switchman-doctor`를 실행해 크리덴셜 없이 도는 로컬 진단 리포트를 받고, 보고된 모든 오류를 수정하세요. 그다음 opencode를 재시작해 플러그인이 실제로 로드됐는지 확인하세요 — 로그에 `[opencode-switchman] injected N model shells (agents)`가 있어야 하고, 메인 모델의 시스템 프롬프트에 라이브 `[ROUTES]/[WATERMARK]/[LIMITS]` 배너 블록이 붙어 있어야 합니다.

세 단계가 모두 통과하기 전까지는 성공을 선언하지 마세요. 무엇을 변경했는지 보고하고 검증 증거를 보여주세요.
```

</details>

**전제 조건**: [opencode](https://opencode.ai), CLI/TUI 권장(대화상자, 사이드바, 배너가 가장 풍부하게 표시됩니다; 데스크톱 앱도 동일한 설정과 상태를 공유합니다). 어떤 프로바이더든 동작하며, Copilot / GLM / DeepSeek은 추가로 할당량 인지 라우팅의 혜택을 받습니다. 크리덴셜은 opencode 자체 인증에서 읽기 전용으로만 사용 — 플러그인은 시크릿을 절대 저장하지 않습니다.

## 빠른 시작

6단계. 스크린샷이 있는 전체 워크스루: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **프로바이더 연결** — TUI에서 `/connect`: Copilot OAuth, DeepSeek API 키; GLM Coding Plan은 `zhipuai-coding-plan` 커스텀 프로바이더로 `opencode.json`에 등록.
2. **오케스트레이션에 참여할 모델 선택** — `/models` 실행 후 `ctrl+f`로 즐겨찾기(데스크톱 앱: "Manage models" 토글).
3. **`/switchman-setup`** *(한 번은 필수)* — 가이드 마법사가 매트릭스 전체를 한 번에: 6개 작업 풀(economy / mechanical / main / hard / vision / review) 각각에 모델을 최소 하나 이상 다중 선택한 뒤, 선택한 모델을 강한 순으로 랭킹. TUI가 없나요? `/switchman-setup-chat`이 채팅에서 동일한 가이드 흐름을 실행. 설정이 완료될 때까지 작업 디스패치는 하드 차단 — 미설정 풀이 더 이상 "all models"로 기본 설정되지 않음. 저장된 설정은 핫 리로드되며, 재시작은 완전히 새로운 프로바이더 등록 시에만 필요.
4. **미세 조정** *(선택)* — **`/modelRank`**로 능력 랭킹을 직접 다듬고 **`/poolConfig`**로 풀별 후보 목록을 TUI 대화상자에서 큐레이션(채팅에서는 `-chat` 변형 사용); 수동 항목은 모든 곳에서 초기 기본값보다 우선.
5. **컨텍스트 명령**
   - **`/handover`** — 세션을 백업하고 직접 압축. `[WATERMARK:SESSION]` 줄이 커지고 있거나 작업이 적절한 중단점에 도달했을 때, 자동 핸드오버를 기다리는 대신 사용.
   - **`/ctx-pause`** — 이 세션의 읽기 제한과 자동 핸드오버를 끔. 대용량 파일을 한꺼번에 많이 읽어야 하고 토큰 소모를 감수할 수 있을 때 사용; 측정 자체는 계속 실행됨.
   - **`/ctx-resume`** — 제한을 다시 켬. 무거운 읽기가 끝나는 즉시 사용; opencode 재시작도 같은 효과.
6. **재시작 및 검증** — `[ROUTES]`/`[LIMITS]` 배너와 사이드바의 `switchman` 패널 확인; 뭔가 어긋나 보이면 `/switchman-doctor` 실행. 이후에는 평소처럼 opencode를 사용하면 됨.

## 얻을 수 있는 것

**코어**

- **컨텍스트 수위 제어** — 실시간 세션 측정(`[WATERMARK:SESSION]`), soft/hard/force 임계값, 탐적인 읽기를 자동으로 상한 처리하는 턴별 읽기 예산, 모든 서브에이전트에 적용되는 요약 후 종료 방식의 하드 상한, 그리고 force 수위에서 발동하는 자동 핸드오버(전체 백업 포크 + 압축).
- **자동 의사결정 디스패칭** — 번들된 디스패처 프로토콜이 메인 모델을 디스패처로 바꿈; 6개 인지 레인이 작업을 알맞은 모델에 알맞은 노력으로 라우팅; 6개의 결정론적 게이트가 모든 디스패치를 검사; 장애가 서킷 브레이커와 격리를 발동하고 시스템은 스스로 회복.

**부가 기능**

- **멀티 구독 오케스트레이션** — Copilot / GLM / DeepSeek에 걸친 할당량 인지 라우팅(모든 프로바이더 참여 가능), 피크 시간대 양보, 과금 인지 스코어링, 교차 계열 리뷰 강제.
- **수동 오버라이드** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **가시성** — 모든 시스템 프롬프트에 실시간으로 뜨는 4줄 배너, TUI 사이드바 패널, tmux 패인 미러링, 세션별 아티팩트 워크스페이스, 모든 라우팅 결정의 감사 로그.

전체 옵션 표, 아키텍처, 내부 동작: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## 문서

- 빠른 시작(그림 포함): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- 전체 매뉴얼(설정, 명령, 아키텍처): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- 기술 명세(계약 / 알고리즘 / 실전 테스트 노트): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- 릴리스 노트: [CHANGELOG.md](./CHANGELOG.md)

## 로드맵

근시일 내: 더 많은 프로바이더의 할당량 지원 — Copilot / GLM / DeepSeek 이외의 더 많은 구독 플랜과 종량제 풀. 아직 지원되지 않는 프로바이더가 있다면 [이슈를 열어 주세요](https://github.com/mrzturn/opencode-switchman/issues): 실제 사용이 다음에 지어질 기능을 결정합니다. 제안과 버그 리포트도 언제나 환영합니다.

## 제작자 지원하기

이 플러그인은 오픈소스이며 무료로 사용할 수 있고, 앞으로도 그럴 것입니다. 다만 유지에는 비용이 듭니다: 프로바이더별 어댑터 호환성을 지원하고 테스트하려면 여러 구독을 보유하고 하나씩 디버깅해야 합니다 — 매 차례 실제 돈이 들어갑니다.

플러그인이 정말 도움이 됐고 예산에 여유가 있다면 커피 한 잔 사주세요. 진심으로 감사합니다.

👇

<details>
<summary>☕ 여기를 클릭 【제작자에게 커피 한 잔】</summary>

| Alipay | WeChat Pay | WeChat으로 스캔해 응원 전하기 |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="Alipay QR code" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="WeChat Pay QR code" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="WeChat scan-to-like QR code" /> |

</details>

## 라이선스

[MIT](./LICENSE)
