# Edulet — 이어서 작업하기

패들렛 스타일 실시간 협업 보드(교실·연수용). **런타임 의존성 0** — Node ≥ 22.13 내장 `http`·`node:sqlite`·SSE, 프런트는 빌드 없는 ES 모듈. 저장소 `github.com/dhsy3206/edulet`(공개). 서버·프런트의 유일한 약속은 **`docs/CONTRACT.md`**(어긋나면 문서가 옳다 — 바꿀 땐 문서를 먼저). README 는 사용자용, 이 파일은 작업자용.

## 명령

| 명령 | 뜻 |
|---|---|
| `npm start` | 서버(포트 3000). 처음엔 시드 보드 2개(`/b/demo-board`, `/b/practice`) |
| `npm test` | 단위·통합(브라우저 불필요, 약 30초). **303개** |
| `npm run e2e` | 격리된 크롬 여러 개로 수락 시나리오(Chrome/Edge 필요). **63개** |
| `npm run build:pages` · `npm run e2e:pages` | GitHub Pages 정적 데모 빌드(`dist/`, gitignore) · 그 빌드를 `/edulet/` 아래 정적 서버로 띄워 확인. **86개** |

Git Bash 에서 로컬 빌드는 `MSYS_NO_PATHCONV=1 node tools/build-pages.mjs --base /edulet`(안 붙이면 `/edulet` 이 경로로 바뀐다). 푸시는 `env -u GITHUB_TOKEN git push`(환경변수 토큰이 키링을 가린다). `main` 에 푸시하면 `pages.yml` 이 데모를 배포한다. CI(`ci.yml`)는 `npm test` 만 돌린다 — e2e 는 CI 에서 안 돈다(Chrome 경로 미검증).

## 무엇을 바꾸면 무엇을 돌리나

- 서버(`server/`) → `npm test`. 화면·실시간이 걸리면 `npm run e2e` 도.
- 프런트(`public/`) → `npm run e2e` **와** `npm run build:pages` + `npm run e2e:pages`(같은 프런트가 서비스 워커 "서버"로도 돈다).
- **API 계약이 바뀌면 `public/demo/sw-*.js` 도 같이**(데모 워커가 같은 API 를 구현한다). 예: `/config`·`/auth/*` 사용자 JSON 모양은 `sw-auth.js` 에도 있다.
- 프런트에서 내부 URL 을 새로 만들면 `withBase()`(`public/js/lib/base.js`)를 거친다 — 안 하면 Pages(`/edulet`)에서만 깨진다.
- 보안이 걸린 변경은 읽기 전용 적대적 리뷰어(변경분만) + "검사를 일부러 망가뜨려 테스트가 잡는지" 확인(변이 점검)을 한다. Google 로그인은 그렇게 두 번 돌렸다.

## 구조

`server/`(http.js 라우터·auth.js·google.js·boards/posts/…·realtime.js SSE·preview.js SSRF 방어·seed) · `public/js/{lib,views,board}` · `public/demo/`(Pages 워커 서버) · `seed/` · `test/`(node:test, `test/index.js` 가 `*.test.js` 를 모두 불러온다) · `e2e/{run,pages}.mjs` · `tools/{cdp,ports,build-pages}.mjs` · `docs/`. 설정은 전부 환경변수 `EDULET_*`(`server/config.js`, 표는 CONTRACT §1).

## Google 로그인 (2026-10-22 추가, 서버 모드 전용)

- 서버가 OAuth 인증 코드 + PKCE 를 전부 처리(`server/google.js`). 켜는 법·정책·API 는 README "Google 로그인 켜기"와 CONTRACT §5 "Google 로그인". 프런트: `public/js/views/auth.js`(버튼·프로필의 연결/해제·`showAuthFlash`).
- **Pages 데모는 `google:false`** — 워커에 Google 경로가 없다(일부러).
- 테스트는 진짜 Google 이 아니라 **`test/google-mock.js`**(가짜 Google + 브라우저식 리디렉션 워커)로 한다: `test/google.test.js`(52개), `e2e/run.mjs` 의 S7. 다른 곳에서 Google 을 흉내 낼 땐 `createApp({ googleEndpoints, config })`(테스트 전용 옵션).
- **진짜 Google 계정으로는 시험하지 못했다**(클라이언트 ID 없음). 켠 뒤 한 번 로그인해 보는 것이 남은 검증이다.
- 사용자 JSON 의 `hasPassword`·`googleEmail` 은 `/auth/*` 응답(본인)에만 있다. 다른 사람에게 가는 JSON 에 새 칸을 넣을 땐 `userJson` 이 고르는 칼럼만 나가는지 확인할 것.

## 열린 결정·알려진 빈칸

- **라이선스는 교육 목적 한정 사용자 정의 라이선스**(`LICENSE`, 2026-10-22 추가; 한국어본이 효력, 영어본은 참고). OSI 오픈소스가 아니고 변호사 검토도 받지 않았다. 저작권자 표기는 GitHub 아이디 `dhsy3206`(바꾸려면 `LICENSE` 의 Copyright 줄). 제5조가 QR 라이브러리·`seed/` 참조 보드 자료·제3자 상표를 적용 대상에서 뺀다 — 새 제3자 자료를 넣으면 제5조에도 적는다. 영리 교육업체(학원)·기업 연수는 "영리 목적/교육 목적 아님"으로 읽혀 서면 허락 대상이다.
- `seed/demo-board.json`·`seed/img/` 에 참조 보드 작성자의 표시 이름과 이미지가 들어 있고 저장소가 공개라 **지금 공개 중** — 원 작성자 동의가 불확실하면 바꾸거나 지울 것.
- 여럿이 같은 보드를 실시간으로 쓰려면 서버 모드가 필요(Pages 는 브라우저 로컬). 공개 운영: HTTPS + `TRUST_PROXY=1` + `COOKIE_SECURE=1`(또는 https `PUBLIC_URL`), 프록시의 SSE 버퍼링 끄기.
- 고치지 않고 남긴 것: `/auth/login` 의 실패 계수가 해시 뒤에 올라가 동시 추측이 한꺼번에 통과(Google 용 `confirmPassword` 는 이미 앞에서 센다) · `test/seed.test.js` 의 직접 `createApp` 두 곳이 아직 나쁜 포트 재굴림을 안 쓴다 · 보드 탭을 6개 넘게 열면 브라우저 호스트당 연결 제한으로 지연.

## 함정(겪은 것)

- **임의 포트(`listen(0)`)가 fetch·Chrome 이 막는 "나쁜 포트"(4045 등)를 받으면** 첫 요청이 `fetch failed (bad port)` 로 죽는다 → 새 서버는 `tools/ports.mjs` 의 `listenOnGoodPort` / `test/helpers.js` 의 `createAppOnGoodPort` 로 띄운다. 간헐 실패가 보이면 메시지의 포트부터 본다.
- e2e: 모달은 나중에 autofocus 를 옮기므로 입력 전에 `document.activeElement` 가 그 칸이 될 때까지 기다린다. 화면 아래의 **토스트가 마우스 클릭을 가로챌 수 있다** — 클릭 전에 토스트가 사라질 때까지 기다린다.
- `api.js` 는 401 마다 "세션 만료"로 보지만 `bad_credentials`(틀린 비밀번호)는 예외다.
- 긴 한글이 든 셸 heredoc 은 도구에서 깨지기도 한다 — 길면 파일로 쓰고 실행한다. Windows 한글 경로·파일은 UTF-8 로(`python -X utf8`).
- `dist/` 와 `e2e/out/`(캡처) 는 산출물이다(gitignore, 커밋하지 않는다).
