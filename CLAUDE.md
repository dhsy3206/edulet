# Edulet — 이어서 작업하기

패들렛 스타일 실시간 협업 보드(교실·연수용). **런타임 의존성 0** — Node ≥ 22.13 내장 `http`·`node:sqlite`·SSE, 프런트는 빌드 없는 ES 모듈. 저장소 `github.com/dhsy3206/edulet`(공개). 서버·프런트의 유일한 약속은 **`docs/CONTRACT.md`**(어긋나면 문서가 옳다 — 바꿀 땐 문서를 먼저). README 는 사용자용, 이 파일은 작업자용.

## 명령

| 명령 | 뜻 |
|---|---|
| `npm start` | 서버(포트 3000). 처음엔 시드 보드 1개(`/b/practice`) |
| `npm test` | 단위·통합(브라우저 불필요, 약 30초). **327개** |
| `npm run e2e` | 격리된 크롬 여러 개로 수락 시나리오(Chrome/Edge 필요). **111개** (`node e2e/run.mjs S8` 처럼 시나리오 이름으로 골라 돌릴 수 있다) |
| `npm run build:pages` · `npm run e2e:pages` | GitHub Pages 정적 데모 빌드(`dist/`, gitignore) · 그 빌드를 `/edulet/` 아래 정적 서버로 띄워 확인. **97개** |

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

## 공유 주소 (`/config.share`)

- 서버 `GET /api/config` 의 `share: { origin, lan }`(`origin` = `PUBLIC_URL` 원점 또는 null, `lan` = 같은 네트워크 기기가 열 수 있는 주소들 — localhost 로 연 이 PC 의 소유자에게만 채워진다; 규칙·시험은 CONTRACT `/config`). 프런트 `public/js/lib/share-origin.js` 의 `shareInfo()`·`shareOrigin()` 이 **http(s) 원점 형식을 검증한 뒤에만** 링크·QR 에 쓰고(`javascript:`·경로·인증정보는 무시), `boardUrl`·`postUrl`·공유 창(`views/share-panel.js`: LAN 주소 select·방화벽/localhost 경고·데모 안내 상자)이 이를 쓴다. 새 링크 만들 곳에서 `location.origin` 을 직접 쓰지 마라.
- 데모 워커 `/config` 는 `share:{origin:null,lan:[]}` 를 낸다(`sw-auth.js`) — 데모의 링크·QR 은 다른 기기에서 안 열린다는 것을 공유 창이 알려 준다. 게스트 입장 창에는 **"이름 없이 바로 참여"**(`참여자 NNN`, `board-controller.js` `ensureIdentity`).
- e2e S8·S8b 는 `createApp({ host:'0.0.0.0', networkInterfaces })` 로 가짜 NIC 를 주입한다. **주의: 서버가 NIC 목록에서 127.x 를 거르므로 `127.0.0.2` 는 `share.lan` 에 안 들어가고**, S8 은 이 PC 의 실제 사설 IPv4(와이파이·유선)를 "다른 PC" 주소로 대신 쓴다(INFO 한 줄) — 소유자(localhost)와 "다른 PC"(LAN 주소, 쿠키가 따로)가 서로 다른 원점이 된다. 사설 IPv4 가 없는 PC(오프라인)에서는 S8 이 `share.lan` 검사부터 줄줄이 실패한다(e2e 는 CI 에 없다 — 로컬에서 네트워크에 연결하고 돌릴 것). 공유 창은 열 때마다 `/config` 를 다시 읽어(`store.refreshConfig`, 실패하면 기존 값 유지) 무선 IP 가 바뀌어도 새 주소로 링크·QR 을 만든다. 사용자용 한 장 안내는 `docs/server-mode.html`. 공유 창의 select·안내 상자·모바일 폭·적대적 `/config`(`javascript:`·경로·인증정보)도 여기서 본다.
- 새 게스트가 들어오면 컨트롤러가 스냅샷을 다시 받는다(`_reload`). 첫 쓰기는 그 재로딩이 끝난 뒤에 보낸다(`_identity()`) — 안 그러면 쓰기보다 먼저 요청해 새 카드가 들어 있지 않은 스냅샷이 쓰기 응답보다 늦게 도착해 방금 쓴 카드가 자기 화면에서 지워지는 경합이 있었다(S8 의 "느린 스냅샷" 시험이 잡는다).

## 열린 결정·알려진 빈칸

- **라이선스는 PolyForm Strict License 1.0.0**(`LICENSE` = 공식 영어 원문 그대로 + 맨 위 `Required Notice:` 한 줄, 2026-10-22). 비영리 목적으로 있는 그대로 쓰는 것만 허락하고 수정·배포·영리 사용은 불허. **`LICENSE` 본문은 고치지 않는다**(공식 원문과 바이트 동일). SPDX 에 Strict 항목이 없어 `package.json` 은 `SEE LICENSE IN LICENSE`. 저작권자 표기는 GitHub 아이디 `dhsy3206`(바꾸려면 Required Notice 줄). QR 라이브러리·제3자 상표는 `NOTICE` 가 적용 대상에서 뺀다 — 새 제3자 자료를 넣으면 `NOTICE` 에도 적는다. 같은 날 먼저 올렸던 자체 작성 "교육 목적 한정" 라이선스(커밋 5437b22)는 이것으로 대체됐다.
- **제3자 자료는 저장소에 두지 않는다.** 예전에 공개 참조 보드를 옮긴 시드 보드(작성자 이름·이미지 포함)와 분석 노트·스크린샷이 있었으나 2026-10-22 에 GitHub(작업 트리·git 기록·Pages)에서 내렸다. 시험은 자체 픽스처만 쓴다(그 자료가 사용자 PC 의 `seed/` 에 되살아나 있어도 결과가 같아야 한다). 로컬 복원분은 `.git/info/exclude` 로 커밋이 막혀 있다 — **`git add -f` 금지**. 새 시드·문서·스크린샷에 남의 보드 내용이나 작성자 이름을 옮기지 마라.
- 여럿이 같은 보드를 실시간으로 쓰려면 서버 모드가 필요(Pages 는 브라우저 로컬). 공개 운영: HTTPS + `TRUST_PROXY=1` + `COOKIE_SECURE=1`(또는 https `PUBLIC_URL`), 프록시의 SSE 버퍼링 끄기.
- 고치지 않고 남긴 것: `/auth/login` 의 실패 계수가 해시 뒤에 올라가 동시 추측이 한꺼번에 통과(Google 용 `confirmPassword` 는 이미 앞에서 센다) · `test/seed.test.js` 의 직접 `createApp` 두 곳이 아직 나쁜 포트 재굴림을 안 쓴다 · 보드 탭을 6개 넘게 열면 브라우저 호스트당 연결 제한으로 지연.

## 함정(겪은 것)

- **`DATA_DIR` 기본값 `./data` 는 서버 파일이 아니라 "프로세스를 시작한 폴더" 기준**이다(`path.resolve`, 실제로 다른 폴더에서 켜 보니 거기에 새 빈 `data` 가 생겼다) → 바로가기·작업 표시줄·스케줄러로 켜면 "작업이 사라진" 것처럼 보인다. `run.cmd` 는 `cd /d "%~dp0"` 로 자기 폴더에서 시작하고(줄바꿈은 CRLF 유지 — `.gitattributes`), 사용자 안내는 `docs/server-mode.html` 4번. 서버 코드의 기본값을 바꾸면 이미 다른 폴더에 데이터를 쌓아 온 사람이 갑자기 빈 화면을 보게 되니 바꾸지 말고 안내로 푼다.
- **임의 포트(`listen(0)`)가 fetch·Chrome 이 막는 "나쁜 포트"(4045 등)를 받으면** 첫 요청이 `fetch failed (bad port)` 로 죽는다 → 새 서버는 `tools/ports.mjs` 의 `listenOnGoodPort` / `test/helpers.js` 의 `createAppOnGoodPort` 로 띄운다. 간헐 실패가 보이면 메시지의 포트부터 본다.
- e2e: 모달은 나중에 autofocus 를 옮기므로 입력 전에 `document.activeElement` 가 그 칸이 될 때까지 기다린다. 화면 아래의 **토스트가 마우스 클릭을 가로챌 수 있다** — 클릭 전에 토스트가 사라질 때까지 기다린다.
- `api.js` 는 401 마다 "세션 만료"로 보지만 `bad_credentials`(틀린 비밀번호)는 예외다.
- 긴 한글이 든 셸 heredoc 은 도구에서 깨지기도 한다 — 길면 파일로 쓰고 실행한다. Windows 한글 경로·파일은 UTF-8 로(`python -X utf8`).
- `dist/` 와 `e2e/out/`(캡처) 는 산출물이다(gitignore, 커밋하지 않는다).
