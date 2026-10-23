# Edulet — 이어서 작업하기

패들렛 스타일 실시간 협업 보드(교실·연수용). **런타임 의존성 0** — Node ≥ 22.13 내장 `http`·`node:sqlite`·SSE, 프런트는 빌드 없는 ES 모듈. 저장소 `github.com/dhsy3206/edulet`(공개). 서버·프런트의 유일한 약속은 **`docs/CONTRACT.md`**(어긋나면 문서가 옳다 — 바꿀 땐 문서를 먼저). README 는 사용자용, 이 파일은 작업자용.

## 명령

| 명령 | 뜻 |
|---|---|
| `npm start` | 서버(포트 3000). 처음엔 시드 보드 1개(`/b/practice`) |
| `npm test` | 단위·통합(브라우저 불필요, 약 2~3분). **528개**(2026-10-23 직접 실행: 기존 379 + 저장하기·불러오기 `test/restore.test.js` 70 + 내보내기 `test/export-html.test.js` 45·`test/export-hardening.test.js` 33 + 보정) |
| `backup.cmd` · `node tools/backup.mjs [--data <dir>] [--out <dir>]` | **서버를 켠 채로** 안전한 백업(`backups/edulet-날짜-시간/`: `edulet.db` 스냅샷·`uploads/`·`BACKUP-INFO.txt`). 계약 CONTRACT §1 "백업" |
| `npm run e2e` | 격리된 크롬 여러 개로 수락 시나리오(Chrome/Edge 필요). **267개**(2026-10-23 전체 실행: 기존 111 + 내보내기 S9 76 + 저장하기·불러오기 S10·S10b 80 — `node e2e/run.mjs S10` 은 둘 다 돈다) (`node e2e/run.mjs S8` 처럼 시나리오 이름으로 골라 돌릴 수 있다) |
| `npm run build:pages` · `npm run e2e:pages` | GitHub Pages 정적 데모 빌드(`dist/`, gitignore) · 그 빌드를 `/edulet/` 아래 정적 서버로 띄워 확인. **113개**(2026-10-23 전체 실행: 기존 97 + 내보내기 P3h 12 + 저장하기·불러오기 메뉴가 데모에 없음 P6 4 — `node e2e/pages.mjs P3h`·`P6` 처럼 이름으로 고를 수 있다) |

Git Bash 에서 로컬 빌드는 `MSYS_NO_PATHCONV=1 node tools/build-pages.mjs --base /edulet`(안 붙이면 `/edulet` 이 경로로 바뀐다). 푸시는 `env -u GITHUB_TOKEN git push`(환경변수 토큰이 키링을 가린다). `main` 에 푸시하면 `pages.yml` 이 데모를 배포한다. CI(`ci.yml`)는 `npm test` 만 돌린다 — e2e 는 CI 에서 안 돈다(Chrome 경로 미검증).

## 무엇을 바꾸면 무엇을 돌리나

- 서버(`server/`) → `npm test`. 화면·실시간이 걸리면 `npm run e2e` 도.
- 프런트(`public/`) → `npm run e2e` **와** `npm run build:pages` + `npm run e2e:pages`(같은 프런트가 서비스 워커 "서버"로도 돈다).
- **API 계약이 바뀌면 `public/demo/sw-*.js` 도 같이**(데모 워커가 같은 API 를 구현한다). 예: `/config`·`/auth/*` 사용자 JSON 모양은 `sw-auth.js` 에도 있다.
- 프런트에서 내부 URL 을 새로 만들면 `withBase()`(`public/js/lib/base.js`)를 거친다 — 안 하면 Pages(`/edulet`)에서만 깨진다.
- 보안이 걸린 변경은 읽기 전용 적대적 리뷰어(변경분만) + "검사를 일부러 망가뜨려 테스트가 잡는지" 확인(변이 점검)을 한다. Google 로그인은 그렇게 두 번 돌렸다.

## 구조

`server/`(http.js 라우터·auth.js·google.js·boards/posts/…·realtime.js SSE·preview.js SSRF 방어·seed·backup.js/backups.js/restore.js 저장하기·불러오기) · `public/js/{lib,views,board}` · `public/demo/`(Pages 워커 서버) · `seed/` · `test/`(node:test, `test/index.js` 가 `*.test.js` 를 모두 불러온다) · `e2e/{run,pages}.mjs` · `tools/{cdp,ports,build-pages,backup}.mjs` · `docs/`. 설정은 전부 환경변수 `EDULET_*`(`server/config.js`, 표는 CONTRACT §1).

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

## 저장하기·불러오기 (2026-10-23, 서버 모드 전용)

- 서버 PC 의 localhost 로 연 화면의 헤더(저장하기·불러오기, 아이콘만으로 줄어듦)와 사용자 메뉴(보드 화면 포함)에서 연다. 화면 `public/js/views/backup-dialog.js`(저장 창·불러오기 창: 목록 → 미리보기 → 확인 → 진행 → 결과 → **전체 새로고침**), 헤더 `views/shell.js`, 메뉴 `views/auth.js`, SSE `reset` 처리 `lib/board-controller.js`(+ 공유 표식 `lib/backup-state.js`), 스타일 `css/backup.css`(app.css 와 따로). 서버·계약은 CONTRACT §5 "저장하기·불러오기"(`server/backups.js`·`restore.js`·`backup.js`), 시험 `test/restore.test.js`·e2e S10/S10b·pages P6.
- **`localOperator` 게이트**: 메뉴는 `/config.backup.available === true` 일 때만 **그려지고**(안 그릴 때는 숨김이 아니라 제거 — `store.subscribe('config')` 로 바뀌면 다시 그린다), API 도 같은 판정으로 막는다(`backup_local_only`). `PUBLIC_URL`(공개 주소)·프록시/터널 헤더·localhost 가 아닌 Host·loopback 이 아닌 접속 IP 중 하나라도 있으면 false — **공개 주소를 설정한 서버는 서버 PC 에서 localhost 로 열어도 메뉴가 없다**(그때는 `backup.cmd`). Pages 데모는 항상 false(`sw-auth.js`). 비게스트 계정이 하나라도 있으면 로그인한 계정으로만(`member_required`) — 학생과 같이 쓰는 공용 서버 PC 에서는 그 PC 에서 가입한 누구나 쓸 수 있으니 `ALLOW_REGISTER=0` 권장(README·server-mode.html 에 적음).
- **같은 연결 교체**: 불러오기는 살아 있는 DB 연결(`app.db.raw`)에서 한 트랜잭션으로 표를 비우고 채운다 — 연결을 닫고 다시 열지 않는다(다른 모듈이 `app.db` 래퍼·준비된 문장을 붙잡고 있음). 교체는 동기라 큰 DB 에서 서버가 잠깐 멈춘다. **점검 모드**(`app.maintenance`): 그동안 GET/HEAD 가 아닌 `/api` 요청은 503 `busy`(`/api/backups*` 는 뮤텍스 409), 읽기·SSE 는 계속, 업로드 정리·세션 청소 타이머는 쉰다.
- **안전 저장 + `total_changes()`**: 불러오기 직전에 `before-restore` 저장본을 만들고(목록에 "자동 저장"), 그 사이 DB 에 쓰기가 있었으면(`total_changes` 가 달라짐) 다시 만들거나 `data_changed` 로 중단한다 — 데이터 손실을 막는 마지막 방어선이니 이 검사와 교체 사이에 `await` 를 넣지 마라. 업로드 파일은 이미 있는 것을 건드리지 않고 복사만 한다.
- **세션 정책**: 저장본의 `sessions` 는 버리고, 교체 직전의 살아 있는 세션 중 같은 사람(id·created_at·is_guest·username·google_sub)이 교체 뒤에도 있는 것만 다시 넣는다 → 응답 `keptSession`. 그래서 같은 서버의 저장본이면 로그인이 유지되고, 다른 PC 의 저장본이면 저장본의 계정으로 다시 로그인해야 한다(화면은 이 경우 "홈으로 가기"). 비밀번호도 저장 당시로 돌아간다(확인 단계에 적음).
- **401 을 쓰지 않는다**: `api.js` 는 401 마다 "세션이 끝났다"고 보고 로그아웃시킨다. 그래서 서버는 게이트 실패를 403(`member_required`·`backup_local_only`)으로 낸다 — 화면 시험(S10)이 게스트·다른 기기에서 이 응답들에 401 이 없고 게스트가 로그아웃되지 않음을 본다. 서버에 새 거절을 넣을 때도 401 은 금지.
- **`backupHooks`**(`createApp` 시험 전용 옵션 — `afterValidate`·`afterStage`·`afterSafetySave`)는 불러오기가 단계 사이에 `await` 하는 곳에서 실패·쓰기·지연을 만들어 보는 길이다. e2e 는 `afterSafetySave` 로 진행 화면을 오래 붙잡는다(CDP 호출은 서버가 일하는 동안·다른 시험이 같이 돌 때 느려지니 넉넉히 — 12초).
- **화면 함정**: ① 불러온 뒤 페이지 상태는 전부 낡았으니 **`location.assign`(전체 새로고침)** 으로 간다(SPA `router.go` 금지). 읽을 게 없으면 4.5초 뒤 자동(`window.__EDULET_BACKUP_MOVE_MS` 로 시험이 늘린다), 경고·로그인 필요가 있으면 단추를 누를 때까지 기다린다. ② **작업 중(저장·불러오기)에는 창을 닫을 수 없다** — `modal({ persistent })` 는 Esc·바깥 클릭만 막고 헤더 X 는 못 막으므로 창 틀(`createPanel`)이 `persistent` 를 켜 두고 Esc·바깥 클릭을 직접 처리하며 잠금(`bk-locked`) 동안 X 를 CSS 로 뺀다. ③ **SSE `reset`**: 서버가 불러오기 직후 모든 보드 연결에 보내고 닫는다 → 그 보드를 보던 탭은 토스트 뒤 1.2초에 한 번 `location.reload()`(루프 없음 — 새 연결은 정상 `hello`), **시작한 탭은 `backupState.restoring` 으로 무시**하고 자기 창이 결과를 보여 준 뒤 스스로 이동한다(실패하면 표식을 끈다). 보드가 아닌 화면(대시보드)에는 연결이 없어 reset 이 안 간다 — 시험은 시작 탭을 보드 화면에 두어야 이 표식을 본다(S10). ④ 미리보기는 요청마다 서버를 잠깐 붙잡으니 저장본마다 한 번만 묻고(창 동안 캐시) 한 번에 하나만 보낸다(`previewing`) — 화살표로 고르는 것만으로는 요청하지 않는다(Enter·클릭). 429 도 미리보기에서 날 수 있다(대기 시간 안내). ⑤ `api.js` 의 기본 요청 제한시간 20초는 큰 DB 의 저장·불러오기에 짧아 `api.post(경로, 본문, { timeout })` 으로 10분을 준다. ⑥ 서버가 준 경고 문장·보드 제목·저장본 이름은 DB 값이니 **텍스트 노드로만**(`innerHTML` 금지 — `h()` 만 쓴다).
- **e2e 함정**: `tools/cdp.mjs` 의 `waitFor(식)` 은 괄호·`document.` 가 없는 식을 CSS 선택자로 착각해 조용히 시간 초과가 난다 → `(window.x === undefined)` 처럼 괄호로 시작한다. 로그인 창은 입력 전에 `document.activeElement` 가 그 칸이 될 때까지 기다린다(나중에 포커스를 옮겨 입력이 엉뚱한 칸에 들어간다). 일부러 깨 본 결과(11개 변이 — `available` 조건, reset 무시 표식, reset 이벤트, 확인 단계 생략, 작업 중 Esc, 중복 저장 방지, SPA 이동, 사용자 메뉴, 실패 뒤 표식 해제, 헤더 제거, 미리보기 캐시)는 모두 S10/S10b 가 잡는 것을 확인했다 — 새로 고칠 때 같은 식으로 다시 깨 볼 것.

## HTML 오프라인 내보내기 (2026-10-23, 서버·데모 공통 — 클라이언트가 만든다)

- 보드 한 장을 스크립트 없는 `.html` 파일 하나로(README "보드를 HTML 파일로 내보내기"). **서버 API 없음** — 재료는 기존 `GET /boards/:slug/export?format=json`(보는 사람에 맞게 작성자 숨김·username 가공·댓글 포함)과 거기서 참조되는 `/uploads/…` 파일뿐이라 서버 모드와 Pages 데모가 같은 코드로 돈다(데모 워커 변경 없음). 구성: `public/js/lib/export-html.js`(DOM 없는 순수 문자열 빌더 — `buildOfflineHtml`/`buildOfflineParts`/`buildOfflinePartsAsync`, `esc`, `safeHttpUrl`, `renderRichHtml`, `EXPORT_LIMITS`, `CSP`), `export-offline.js`(브라우저 로더: 받기·줄이기·한도·진행·취소), `image-bytes.js`(PNG/JPEG/GIF/WebP 헤더 크기 읽기·메타데이터 자르기), 화면은 `views/share-panel.js` 내보내기 구역·`board-topbar.js` 버튼·`dashboard.js`+`board-actions.js` 카드 메뉴.
- **불변식(깨면 안 된다)**: ① 파일에 `<script` 가 한 번도 없고 CSP 메타(`default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`)가 `<meta charset>` 바로 다음(어떤 사용자 값보다 앞)에 있다 — 메타 CSP 는 `<meta http-equiv=refresh>` 를 못 막으니 **escape 가 유일한 방어**다. ② 모든 사용자 값은 `esc`, 링크는 `http(s)` 절대 주소만(2048자 이하), 원격 이미지·링크 미리보기 썸네일은 담지 않는다(열 때 외부 접속 0). ③ 첨부 파일은 항상 `application/octet-stream` 으로 재포장, `data:` 는 허용 mime 의 base64 만. ④ 로더는 `/uploads/<32hex 또는 데모 seed-N>/<한 조각>` 만 받는다(점뿐인 이름·`..`·인코딩 우회 거부) — 내보내기 JSON 이 가리키는 다른 주소로 fetch 하면 교사 브라우저가 공격자 서버·내부 주소로 요청을 보내게 된다. ⑤ **불완전한 파일이 성공처럼 나가면 안 된다**: 한도 초과·디코딩 불가·실패한 파일은 파일 안 "담지 못한 파일" 목록 + 끝난 뒤 요약에 올리고, 글자 한도(`EXPORT_LIMITS.textBytes`)를 넘으면 파일을 아예 안 만든다. ⑥ 기본 모드에서는 JPEG 의 GPS EXIF 가 어떤 경로로도 파일에 남지 않는다(작은 JPEG 는 APP1/XMP/IPTC 등을 잘라 화소·방향만 유지, 큰 것은 canvas 로 다시 인코딩) — "원본 크기" 옵션과 GIF 만 예외(옵션 설명에 적음).
- **`trimUrl` 은 `markdown.js` 와 `export-html.js` 에 같은 코드로 있다**(S9 가 DOM↔문자열 `innerHTML` 동등성을 20가지 입력으로 본다) — 고칠 때 **둘 다**. 예전 구현은 `)` 로 끝나는 긴 주소에서 O(n²)(글 1개 0.9초·30개 30초, 라이브 보드도 같은 비용)였고 지금은 선형 + 길이 상한이다(`test/export-hardening.test.js` 가 시간을 본다).
- 그림은 디코딩 전에 헤더로 화소 수를 읽어 약 4천만 화소 초과는 건너뛰고(압축 폭탄: 작은 PNG 가 수 GB 를 쓴다), 디코딩은 동시 1개(받기는 3개), 디코딩 실패 시 원본을 그냥 담는 폴백은 잘라 낸 뒤 1MB 이하일 때만. 로더 풀은 파일별 try/catch — 한 파일 실패가 나머지를 버리지 않고, 끝난 뒤 `onProgress` 는 무시(진행 문구가 빨간 오류를 덮어쓰던 좀비 방지), 화면에는 한국어 문장만(`exportErrorText`).
- 시험: 단위 `test/export-html.test.js`(escape·스킴·CSP·형식별·한도)·`test/export-hardening.test.js`(헤더 파서·EXIF 제거·풀 실패 주입·`trimUrl` 선형·점 이름·비동기 빌드 취소), e2e S9(실제 다운로드를 받아 `file://` 로 열고 이미지 `naturalWidth`·네트워크 0건·스크립트 흔적 없음·CSP 위반 없음·오프라인 에뮬레이션·7형식·악성 JSON 17종에 공격자 리스너 0건·320/340/360px 막대 넘침), pages P3h(데모에서 같은 흐름·`seed-N` 업로드). 변이 점검은 단위 28종+e2e 3종 모두 잡힘(escape·스킴 필터·CSP 메타·원격 이미지·`trimUrl` 이차식·EXIF·한도·풀·직렬 디코딩). 다운로드는 `e2e/rawcdp.mjs`(`tools/cdp.mjs` 가 띄운 크롬에 두 번째 DevTools 연결을 열어 다운로드 허용·탭별 Network 를 본다), 시험용 그림은 `e2e/image-fixtures.mjs`(GPS 가 든 JPEG·방향 표식·압축 폭탄 PNG).
- 알려진 한계: 큰 보드는 메모리가 크다(문자열+Blob 약 2배, 합계 150MB 근처에서 4GB 급 PC 는 부담), `data:` 다운로드 링크는 Chrome 에서만 확인했다(Firefox/Safari·구형 브라우저는 미확인), 라이트박스는 JS 가 없어 Esc 로는 못 닫는다, 인쇄 시 댓글(`<details>`)은 `::details-content` 를 지원하는 브라우저에서만 펼쳐진다, 본문의 bidi 제어문자는 그대로(라이브 앱과 동일). **함정**: Write 도구가 내용 속 ` ` 같은 `\uXXXX` 를 실제 문자로 바꿔 쓸 수 있고, 파이썬으로 고칠 때 `newline=''` 없이 쓰면 Windows 에서 LF→CRLF 로 바뀐다(이 저장소 JS 는 LF — `git ls-files --eol`).

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
- **WAL 때문에 `data/edulet.db` 본파일은 서버가 켜진 동안 낡은 값(비어 있거나 최근 작업이 빠진 파일)이다** — 작업은 `edulet.db-wal` 에 있다. 켜 둔 채 본파일만 복사하면 빈·낡은 백업이므로 백업은 `tools/backup.mjs`(원본을 **읽기 전용**으로 열어 `VACUUM INTO` — `openDb`·마이그레이션·checkpoint·쓰기 금지, 서버가 꺼져 WAL 이 남은 폴더에서도 WAL 을 본파일에 합치거나 지우지 않는다; 단 꺼진 `data` 를 읽으면 SQLite 가 빈 `-wal`·`-shm` 을 새로 만들 수 있다)로만 만든다. 이 도구를 고칠 때 원본에 쓰는 길(RW 로 열기)이 생기지 않게 하고, 시험(`test/backup.test.js`: 서버 켠 채·크래시 이미지·쓰기 폭풍·`.partial`·SIGKILL·실제 `cmd.exe /c backup.cmd`)을 일부러 깨 보라.
- **백업 결과의 신뢰 규칙**: 작업은 `edulet-….partial` 에서 하고 **마지막에 이름을 바꾼다**(정상 이름의 폴더 = 완전한 백업, `.partial` = 끊긴 것, 자동 정리 없음). CLI 종료 코드 **0 완전 / 1 실패 / 2 경고 있음**(`warnings` 가 있거나 `uploads.missing > 0` → 폴더는 남기고 "주의:" 를 먼저 찍는다) — 불완전한 백업이 성공처럼 보이면 안 된다. `data/uploads` **폴더** 링크는 따라가고(경고) 개별 파일 링크만 건너뛴다. 잠긴 업로드(EBUSY/EPERM/EACCES)는 3번 재시도 뒤 `missing`+경고. 오류는 한 줄(스택은 `EDULET_DEBUG`). 끝에 원본 경로·가장 최근 글·WAL 시각을 찍는 것은 **엉뚱한(낡은) data 를 "성공"으로 백업하는 사고**를 눈에 띄게 하려는 것이다 — 서버를 `EDULET_DATA_DIR` 로 켰다면 `backup.cmd` 쪽에도 같은 환경변수가 필요.
- **`backups/` 와 `edulet-????????-??????*/` 는 사용자 데이터라 `.gitignore`·`.dockerignore` 에 있다**(커밋·이미지 금지 — 비밀번호 해시·세션이 들어 있다). `backup.mjs` 의 `--data` 기본값은 **이 파일 위치 기준 저장소 루트의 `data`**(또는 `EDULET_DATA_DIR`)이고 서버의 `DATA_DIR=./data` 는 **프로세스의 현재 폴더 기준**이라 일부러 다르다 — 서버를 다른 폴더에서 켰다면 `--data` 로 가리킨다. `--out` 이 data 안이면 거부. `backup.cmd` 는 `.gitattributes` 대로 CRLF 이고 **문구는 ASCII 만**(한글은 콘솔 코드페이지에서 깨진다 — 한글 메시지는 `backup.mjs` 가 낸다). **시험·실험에서 실제 `./data`(사용자의 진짜 서버 데이터)나 포트 3000 을 가리키지 마라**(임시 폴더·임의 포트만).
- `dist/` 와 `e2e/out/`(캡처) 는 산출물이다(gitignore, 커밋하지 않는다).
