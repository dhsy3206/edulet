# Edulet 설계 계약 (서버 ↔ 프런트 공용 정본)

Padlet 스타일 실시간 협업 게시판. 이 문서가 **서버와 프런트의 유일한 약속**이다. 어긋나면 이 문서가 옳고, 문서를 바꿔야 하면 먼저 바꾼 뒤 양쪽을 맞춘다.
UI 문구는 **한국어**. 코드 식별자·주석은 영어/한국어 혼용 가능하나 기존 파일의 관례를 따른다.

## 0. 원칙

- **런타임 의존성 0개.** `node:http`, `node:sqlite`, `node:crypto`, `node:test`만 쓴다. `npm install` 없이 `npm start` 가 돈다. (Node ≥ 22.13)
- 프런트는 **빌드 없는 ES 모듈** (`public/js/**`). 프레임워크 없음. DOM 은 `h()` 헬퍼로 만들고, **사용자 입력은 항상 textContent/속성으로만** 넣는다 (`innerHTML` 에 사용자 값 금지).
- 저작권: Padlet 의 코드·로고·상표·스톡 이미지를 쓰지 않는다. 구조와 동작만 참고하고 시각은 자체 제작. 앱 이름은 **Edulet**.
- 에러 응답은 항상 `{ "error": { "code": "snake_case", "message": "한국어 사람용 문장" } }` + 알맞은 HTTP 상태.
- 시각은 모두 **epoch milliseconds (정수)**. JSON 키는 camelCase, DB 컬럼은 snake_case.

## 1. 폴더

```
server/        index.js(진입·createApp) config.js db.js(스키마·마이그레이션) http.js(라우터·응답·본문) auth.js
               boards.js posts.js sections.js comments.js reactions.js uploads.js preview.js(링크 미리보기·SSRF 방어)
               realtime.js(SSE) seed.js seed-cli.js constants.js share.js(`/config` 의 `share` — 같은 네트워크 주소)
               backup.js(백업 핵심 — 서버와 `tools/backup.mjs` 가 같이 쓴다) backups.js(저장하기·불러오기 라우트, §5) restore.js(살아 있는 DB 에 되돌려 넣기)
public/        index.html  css/{base,app,board}.css  js/main.js  js/lib/*  js/views/*  js/board/*  assets/
seed/          *.json (시드 보드), img/ (시드 이미지)
test/          *.test.js (node:test)
tools/         backup.mjs(안전한 온라인 백업의 명령줄 — 핵심은 server/backup.js) ports.mjs cdp.mjs build-pages.mjs …
docs/          CONTRACT.md screens/
data/          (gitignore) edulet.db, uploads/
backups/       (gitignore, dockerignore) tools/backup.mjs 와 화면의 "저장하기"·"불러오기"가 만드는 백업 — 사용자 데이터이므로 커밋하지 않는다
backup.cmd     tools/backup.mjs 를 부르는 더블클릭 래퍼(CRLF, ASCII 문구만)
```

설정(환경변수, `server/config.js`): `PORT`(3000) `HOST`(0.0.0.0) `DATA_DIR`(./data — **프로세스의 현재 폴더 기준**으로 절대 경로가 된다; `run.cmd` 는 시작 전에 `cd /d "%~dp0"` 로 자기 폴더로 이동한다. 위치를 고정하려면 절대 경로) `SESSION_DAYS`(30) `MAX_UPLOAD_MB`(20) `ALLOW_REGISTER`(1) `SEED`(auto|0|1, auto = DB 가 비었을 때만) `TRUST_PROXY`(0) `LINK_PREVIEW`(1) `COOKIE_SECURE`(auto: `PUBLIC_URL` 이 https 이거나, TRUST_PROXY 이고 X-Forwarded-Proto=https 이면 Secure) `BACKUP_DIR`(기본 **저장소 루트의 `backups`** — `config.js` 위치 기준이지 현재 폴더 기준이 아니다, `backup.cmd` 의 기본 `--out` 과 같은 곳. 화면의 "저장하기"가 여기에 만들고 "불러오기"가 여기서 읽는다. `data` 폴더 안이면 저장이 거부된다. `createApp({ backupDir })` 로도 줄 수 있다(시험용)). 모두 접두사 `EDULET_`.
남용 방지 한도(모두 양수, 잘못된 값은 기본값; 의미와 오류 코드는 §11):

| 환경변수 | 기본 | 뜻 |
|---|---|---|
| `UPLOAD_CONCURRENCY` | 6 | 서버 전체에서 동시에 올라오는 업로드 수 |
| `UPLOAD_PER_USER` | 2 | 사용자 한 명의 동시 업로드 수 |
| `UPLOAD_RATE` | 30 | 사용자당 10분에 받는 업로드 요청 수 |
| `UPLOAD_QUOTA_MB` | 300 | 사용자당 24시간에 올릴 수 있는 용량(MB) |
| `SSE_PER_USER` | 10 | 로그인 사용자 한 명의 열린 실시간 연결 수 |
| `SSE_PER_IP` | 300 | 접속 주소 하나의 열린 실시간 연결 수 |
| `MAX_CONNECTIONS` | 2000 | http 서버 소켓 상한(`server.maxConnections`) |
| `WRITE_RATE` | 240 | 사용자당 분당 쓰기(게시물·댓글·반응·섹션) 수 |
| `BOARD_MAX_POSTS` | 5000 | 보드 하나의 게시물 수 |
| `LOGIN_FAIL_MAX` | 10 | 사용자명당 15분에 허용하는 로그인(비밀번호 확인) 실패 수 |
| `MEMBER_RATE` | 30 | 사용자당 분당 구성원 추가(=사용자명 조회) 수 |
| `GOOGLE_RATE` | 300 | 접속 주소 하나의 분당 Google 로그인 시도(시작+돌아옴 합산). 비밀번호 해시를 돌리지 않으므로 게스트 한도처럼 넉넉하다 |

**Google 로그인 설정**(§5 "Google 로그인"; 모두 접두사 `EDULET_`):

| 환경변수 | 기본 | 뜻 |
|---|---|---|
| `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` | (없음) | **둘 다 있을 때만** Google 로그인이 켜진다(`GET /config` 의 `google: true`). 하나만 있으면 꺼진 것으로 본다 |
| `PUBLIC_URL` | (없음) | 이 서비스의 주소(`https://edulet.example.com`). Google 에 등록한 "승인된 리디렉션 URI" = `<PUBLIC_URL>/api/auth/google/callback`. 없으면 요청 자체의 주소(`Host`, `TRUST_PROXY` 일 때만 `X-Forwarded-Host/Proto`)로 만든다. 경로·끝 슬래시는 버리고 origin 만 쓰며, http(s) 주소가 아니면 **시작할 때 오류**. https 주소이면 `COOKIE_SECURE=auto` 에서도 세션·흐름 쿠키에 `Secure` 가 붙는다(`COOKIE_SECURE=0` 이 명시되면 그쪽) |
| `GOOGLE_DOMAINS` | (없음) | 쉼표로 나눈 Google Workspace 도메인(`school.ac.kr, edu.example`). 있으면 그 도메인 계정만 로그인(§5). `gmail.com` 을 적으면 일반 Gmail 도 허용 |

`createApp({ dataDir, port, seed })` 를 export 해서 테스트가 임시 폴더·임의 포트로 서버를 띄우고 `{ url, server, close() }` 를 받는다. `npm start` 는 이것을 호출한다. http 서버는 `headersTimeout` 20초, `requestTimeout` 10분을 명시한다.
`npm start` 가 찍는 시작 안내(`announce()`): 첫 줄 `Edulet is running at http://localhost:<port>`, 이어서 **`HOST` 가 loopback 전용(`127.0.0.1`·`localhost`·`::1`)이 아니고 이 PC 의 LAN 주소가 있을 때만** 한 줄 `같은 네트워크의 다른 기기에서는: http://<LAN>:<port>`(주소가 둘 이상이면 ` 또는 ` 로 이어 붙임, 최대 4개 — 고르는 규칙은 §5 `GET /config` 의 `share.lan` 과 같다), 그 뒤에 시드 보드 주소. 컨테이너 안에서는 컨테이너 내부 주소가 찍히므로 그대로 믿지 말 것(포트 매핑은 직접 안내). 시험 전용 `createApp` 옵션 `networkInterfaces`(`os.networkInterfaces` 와 같은 모양을 돌려주는 함수)는 이 목록용 가짜 NIC 를 주입하는 길이며 환경변수·HTTP 로는 바꿀 수 없다.

### 백업 (`server/backup.js`, `tools/backup.mjs`, `backup.cmd`)

서버가 켜진 동안 작업은 `data/edulet.db-wal`(WAL)에 쌓이고 `data/edulet.db` 본파일은 **낡은 값**(비어 있거나 최근 작업이 빠진 파일 — 한가할 때는 수 KB, 바쁠 때는 일부만 반영)이다 → **켜 둔 채 `edulet.db` 만 복사하면 빈(또는 낡은) DB 가 백업된다.** 서버를 끄지 않고 일관된 백업을 만드는 도구가 이것이다.

- 모듈: **핵심은 `server/backup.js`** — 서버가 화면의 "저장하기"·"불러오기"(§5)에서 같이 쓰므로 서버 코드가 `tools/` 를 import 하지 않는다(Docker 이미지에는 `tools/` 가 없다). `tools/backup.mjs` 는 명령줄(`main`·`defaultPaths`·`ROOT`)만 갖고 나머지는 `server/backup.js` 에서 다시 내보낸다. `node:sqlite` 는 `server/sqlite.js` 한 곳에서만 불러온다(그 첫 불러올 때의 ExperimentalWarning 한 가지만 막고 `process.emitWarning` 을 원래대로 되돌린다; `db.js`·`backup.js` 가 같이 쓴다). `backupData({ dataDir, outDir, now = new Date(), kind = 'manual' })`(`kind`: `manual` | `before-restore`) → `{ dir, dataDir, dbBytes, uploads: { files, bytes, missing }, counts: { boards, posts, users }, latestPostAt, wal: { exists, modifiedAt }, warnings: string[] }`. 실패는 `BackupError`(한국어 메시지). CLI: `node tools/backup.mjs [--data <dir>] [--out <dir>]`(`--data=<dir>` 도 됨). `backup.cmd` 는 `cd /d "%~dp0"` 뒤 `node --disable-warning=ExperimentalWarning tools\backup.mjs %*`, 끝에 종료 코드별 영어 한 줄(`Backup FAILED …` / `Backup finished WITH WARNINGS …`), `Safe to run while the server is on. Backups are in the backups folder.`, `pause`, `exit /b <종료 코드>`.
- **종료 코드**: `0` 완전한 백업 · `1` 실패(만들던 폴더는 지움, 원본 무변경) · **`2` 백업은 만들었지만 경고가 있음**(`warnings` 가 하나라도 있거나 `uploads.missing > 0` — 폴더는 남고 stdout 첫 줄이 `주의: 백업을 만들었지만 일부가 빠졌을 수 있어요`, 경고는 stderr 에 `경고: …`). 불완전한 백업이 성공처럼 보이지 않게 하는 규칙이다. `--help` 는 0. 한 줄 오류 메시지만 낸다(스택은 환경변수 `EDULET_DEBUG` 가 있을 때만).
- **기본 경로는 파일 위치 기준이다**: `--data` 기본 = 환경변수 `EDULET_DATA_DIR`(비어 있지 않으면) 아니면 **저장소 루트의 `data`**; `--out` 기본 = 환경변수 `EDULET_BACKUP_DIR`(비어 있지 않으면 — 서버의 같은 변수, 화면의 "저장하기"가 쓰는 폴더) 아니면 저장소 루트의 `backups`. 서버의 `DATA_DIR=./data`(프로세스의 현재 폴더 기준)와 **일부러 다르다** — 서버를 `EDULET_DATA_DIR` 로(또는 다른 폴더에서) 켰다면 백업 쪽에도 같은 환경변수/`--data` 가 필요하다. 어긋나면 옛 `repo\data` 를 "성공"으로 백업하므로, **CLI 는 stdout 에 원본 경로·가장 최근 글 시각(`MAX(posts.created_at)` — 스냅샷에서)·원본 `edulet.db-wal` 의 마지막 수정 시각(열린 핸들의 fstat; Windows 에서 디렉터리 목록 값은 낡을 수 있다; 없으면 `WAL 없음`)을 찍고, 글이 0개면 `⚠ 글이 하나도 없어요 — 서버를 켠 폴더의 data 가 맞는지 확인하세요` 를 덧붙인다(종료 코드는 그대로)**. 같은 값이 `BACKUP-INFO.txt` 에도 있다.
- **결과 폴더** `<out>/edulet-YYYYMMDD-HHMMSS/`(이 PC 의 로컬 시각, 이미 있으면 `-2`, `-3`…). **작업은 `<이름>.partial` 폴더에서 하고 전부 만들어 검증한 뒤 마지막에 이름을 바꾼다** — 그래서 정상 이름의 폴더는 언제나 완전하고(검증 통과 + `BACKUP-INFO.txt` 있음), 도중에 끊기면(Ctrl+C·콘솔 닫기·전원) `.partial` 만 남는다. 이름 충돌은 정상 이름과 `.partial` 양쪽을 본다(기존 폴더를 재사용하거나 덮어쓰지 않는다). **자동 정리는 하지 않는다**(동시에 도는 다른 실행의 폴더일 수 있다) — `.partial` 은 쓰지 말고 지워도 된다고 안내서·README·`BACKUP-INFO.txt` 에 적는다. 안에 정확히 네 가지: `edulet.db`(원본에서 `VACUUM INTO` 한 **단일 파일 스냅샷**, WAL·journal 없음, 기록 중이던 WAL 내용 포함), `uploads/`(스냅샷의 `uploads` 행이 가리키는 파일의 복사 — 행 없는 낱 파일·`.part` 임시 파일은 담지 않는다), `BACKUP-INFO.txt`(UTF-8 BOM·CRLF: 만든 시각·원본 경로·보드/글/사용자 수·가장 최근 글·WAL 시각·업로드 수·경고·**복원 방법** — 첫째로 화면의 '불러오기' 메뉴, 이어서 "화면을 쓸 수 없을 때"의 손작업 1~5단계, 복원 첫머리에 "BACKUP-INFO.txt 가 있는 정상 이름의 폴더만 쓰세요"), **`backup.json`**(UTF-8·BOM 없음, 이름 확정 전 `.partial` 에서 쓴다 — 화면 목록이 폴더를 열어 보지 않고 요약을 보여 주려는 것): `{ "format": 1, "kind": "manual"|"before-restore", "createdAt": <ms>, "counts": { boards, posts, users }, "latestPostAt": <ms|null>, "uploads": { files, bytes, missing }, "dbBytes", "userVersion", "warnings": <개수> }`. **이 파일이 생기기 전에 만든 옛 백업에는 없다 — 읽는 쪽은 항상 없는 경우를 지원한다**(§5).
- **원본을 절대 고치지 않는다**: 원본 DB 는 날 `DatabaseSync(file, { readOnly: true })` + `PRAGMA busy_timeout = 5000` 으로 열어 `VACUUM INTO` 만 실행한다(`openDb` 재사용·마이그레이션·checkpoint·쓰기 금지 — 읽기 전용이라 서버가 꺼져 있고 WAL 이 남은 상태에서도 WAL 을 본파일에 합치거나 지우지 않는다). **단서**: 서버가 꺼져 깨끗이 닫힌 `data` 를 읽으면 SQLite 가 `edulet.db-wal`(0바이트)·`edulet.db-shm`(약 32KB)을 **새로 만들 수 있다**(`edulet.db` 는 그대로, 서버가 다음에 시작하면 알아서 쓴다 — 시험으로 확인). uploads 는 읽기만 한다.
- **검증**: 스냅샷을 열어 `PRAGMA integrity_check` = 정확히 `ok` 한 줄, boards/posts/users 개수·가장 최근 글 시각 읽기. 하나라도 실패하면 **이번 실행이 만든** 폴더(경로가 `<out>` 바로 아래의 `edulet-YYYYMMDD-HHMMSS[-n][.partial]`)만 지우고 실패로 끝낸다. uploads 는 스냅샷 *뒤에* 복사한다(스냅샷에 없는 새 업로드는 담기지 않아 DB 와 어긋나지 않는다). `files + missing` = 스냅샷의 업로드 행 수. 복사 중 사라진 파일·행 id 가 32자리 hex 가 아닌 항목(경로 탈출 방지)·**개별 파일 심볼릭 링크**(따라가지 않음)·다른 프로그램이 잠근 파일(`EBUSY`/`EPERM`/`EACCES`: 0.2초 간격으로 3번 다시 시도한 뒤, 5개가 포기한 뒤에는 한 번만 시도)은 실패가 아니라 `missing` + 경고, DB 에 적힌 크기와 다르면 경고. **`data/uploads` 폴더 자체가 심볼릭 링크·정션(다른 드라이브로 옮긴 경우)이면 따라간다**(`data` 폴더 링크를 따라가는 것과 같다) — 경고 한 줄("uploads 가 바로가기라 <대상> 을 따라갔어요", 종료 코드 2); 가리키는 곳이 없거나 폴더가 아니면 그 행 전부 `missing`. 그 밖의 오류(디스크 가득·입출력 오류)는 백업 전체 실패 + 폴더 제거.
- **거부**(아무것도 만들지 않음): `<data>/edulet.db` 가 없으면 "data 폴더를 찾을 수 없어요: …(서버를 켠 폴더의 data 인지 확인)"; `outDir` 가 `dataDir` 와 같거나 그 안이면(`..`·심볼릭 링크·정션·대소문자를 풀어서 비교) 거부 — 재귀 복사 방지; `outDir` 가 폴더가 아니면 거부.
- `.gitignore`·`.dockerignore`: `backups/` 와 **`edulet-????????-??????*/`**(`--out .` 처럼 저장소 안 어디에 만들어도 비밀번호 해시·세션이 든 백업이 커밋되지 않게; `.partial` 포함).
- 복원(**화면**): 서버를 켠 PC 에서 localhost 주소로 연 화면의 "불러오기" 메뉴 — 서버를 끄지 않고 되돌린다(§5 "저장하기·불러오기"). 복원(**손으로**, 화면을 쓸 수 없을 때): `BACKUP-INFO.txt` 가 있는 정상 이름의 폴더로 — 서버를 끄고 → 현재 `data` 를 따로 옮겨 두고 → 새 `data` 에 백업의 `edulet.db`·`uploads` 복사 → **대상에 옛 `edulet.db-wal`·`edulet.db-shm` 이 있으면 반드시 지운다**(남은 다른 DB 의 WAL 이 복원본에 재생돼 손상) → `run.cmd`. 세션 행도 DB 에 있어 로그인은 유지된다. 시험: `test/backup.test.js`(서버 켠 채·크래시 이미지·쓰기 폭풍·`.partial`·SIGKILL·종료 코드·잠긴 파일·실제 `cmd.exe /c backup.cmd`).

### 운영 참고
- **HTTPS 뒤에 둘 때**: 세션 쿠키는 `COOKIE_SECURE=auto` 에서 `PUBLIC_URL` 이 https 주소이거나(Google 로그인 설정에 쓰는 그 값), `TRUST_PROXY=1` 이고 프록시가 `X-Forwarded-Proto: https` 를 보낼 때만 `Secure` 가 붙는다. (https `PUBLIC_URL` 인 채로 http 로 접속해 시험하면 브라우저가 `Secure` 쿠키를 받지 않아 로그인이 안 된다 — 그때는 `COOKIE_SECURE=0`.) TLS 를 프록시가 끝내는 배포는 `EDULET_TRUST_PROXY=1` (프록시가 `X-Forwarded-For`·`X-Forwarded-Proto` 를 **덮어쓰도록** 설정) 또는 `EDULET_COOKIE_SECURE=1` 을 명시한다. 프록시 뒤에서 `TRUST_PROXY` 를 켜지 않으면 모든 사용자가 한 IP 로 보여 IP 단위 한도(인증 분당 20회, 실시간 연결 60개)를 함께 쓴다. 반대로 서버를 직접 공개하면서 `TRUST_PROXY=1` 을 켜면 `X-Forwarded-For` 를 클라이언트가 속일 수 있으니 켜지 않는다.
- **`linkAccess` 와 구성원 역할**: 실효 역할은 소유자 → 구성원 행(그 역할 그대로) → `linkAccess`(§4) 순이다. 구성원 행은 링크 역할을 **문자 그대로 덮어쓰므로** `read` 구성원이 있는 보드가 `linkAccess=write` 이면, 그 사람이 로그아웃하고 새 게스트로 들어오면 `write` 를 얻는다(막으려면 `linkAccess` 를 낮추거나 `visibility=private`). 서버는 이를 막지 않는다.
- **게스트와 사용자 단위 한도**: 업로드 용량·쓰기·링크 미리보기·실시간 연결 한도는 *사용자*(게스트 포함) 단위다. 게스트 계정은 새로 만들 수 있으므로(IP 당 분당 20회) 이 한도들은 IP 단위 인증 한도·서버 전체 상한(동시 업로드 6, 동시 미리보기 8, 소켓 2000)과 함께 작동한다. 누구나 쓸 수 있는 `linkAccess=write` 보드를 공개 서버에 둘 때는 디스크 여유를 감시한다.
- **같은 네트워크의 다른 PC·휴대폰과 함께 쓰기**: 서버 모드는 기본 `HOST=0.0.0.0` 이라 같은 Wi-Fi·유선망의 기기가 게스트로 들어와 동시에 쓸 수 있다(Windows 방화벽이 Node.js 를 막으면 열리지 않는다). 교사가 `http://localhost:3000` 으로 열면 공유 링크·QR 의 주소가 다른 기기에서 못 여는 `localhost` 가 되므로, 서버가 **같은 네트워크 주소를 `GET /config` 의 `share.lan` 으로 알려 준다**(§5). 인터넷에 공개할 때는 `PUBLIC_URL`(공유 주소 = `share.origin`) + `TRUST_PROXY=1` + `COOKIE_SECURE`.
- **고아 업로드 정리**: 서버를 시작할 때와 6시간마다, 24시간이 지났는데도 게시물 첨부·링크 미리보기 이미지·보드 배경이 가리키지 않는 업로드(파일과 행)를 지운다(올리고 게시하지 않은 파일, 게시물이 사라진 파일). 1시간 넘은 `.part` 임시 파일도 지운다. 이 정리가 없던 버전에서 올라온 데이터는 첫 시작 때 한 번 정리된다.

## 2. 상수 (`server/constants.js` ↔ `public/js/lib/constants.js` 동일 값)

```
FORMATS      = wall | grid | stream | shelf | rows | canvas | backchannel
SECTIONED    = shelf, rows            // 섹션이 있는 형식 (shelf=세로 열, rows=가로 줄)
ROLES (낮음→높음) = read < comment < write < moderate < admin   // owner 는 admin + 삭제/양도
VISIBILITY   = private | link         // link = 주소를 아는 누구나 (linkAccess 역할로)
LINK_ACCESS  = read | comment | write | moderate
REACTIONS    = none | like | vote | star | grade | emoji
EMOJIS       = 👍 ❤️ 😂 😮 😢 🎉
POST_COLORS  = null | red | orange | yellow | green | blue | purple | pink
FONTS        = sans | serif | mono | rounded
SCHEMES      = light | dark            // 카드 색 계열 (어두운 배경용)
WALLPAPERS   = green ocean sunset lavender slate paper mint rose night sunrise  또는 업로드 URL("/uploads/<id>/<name>")
TEMPLATES    = blank | kwl | retro | training
ATTACH_KINDS = image | file | link | video
```
보드 `settings` 기본값: `{ "reactions":"like", "comments":"on", "approval":false, "showAuthor":true, "newPostPosition":"top" }` (`comments`: on|off, `newPostPosition`: top|bottom). 알 수 없는 키는 버린다.
제한: 제목(게시물) ≤ 200자, 본문 ≤ 10000자, 댓글 ≤ 2000자, 보드 제목 ≤ 120자, 설명 ≤ 1000자, 섹션 제목 ≤ 80자, 표시 이름 1–40자, 사용자명 3–30자 `[a-z0-9_.-]`(소문자로 정규화), 비밀번호 ≥ 8자.

## 3. DB (SQLite, `PRAGMA foreign_keys=ON`, WAL, `user_version` 으로 순차 마이그레이션)

```sql
users(id INTEGER PK, username TEXT UNIQUE COLLATE NOCASE NULL, display_name TEXT NOT NULL, password_hash TEXT NULL,
      avatar_color TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      google_sub TEXT NULL (부분 UNIQUE 인덱스: NULL 이 아닌 값만), google_email TEXT NULL)   -- v3, Google 로그인(§5)
sessions(token_hash TEXT PK, user_id → users ON DELETE CASCADE, expires_at INTEGER, created_at INTEGER)
boards(id PK, slug TEXT UNIQUE, owner_id → users, title, description DEFAULT '', format DEFAULT 'wall', wallpaper DEFAULT 'green',
       font DEFAULT 'sans', color_scheme DEFAULT 'light', visibility DEFAULT 'link', link_access DEFAULT 'comment',
       settings TEXT DEFAULT '{}', created_at, updated_at)
board_members(board_id → boards CASCADE, user_id → users CASCADE, role, PK(board_id,user_id))
sections(id PK, board_id → boards CASCADE, title, rank REAL)
posts(id PK, board_id → boards CASCADE, section_id → sections ON DELETE SET NULL, author_id → users, title DEFAULT '', body DEFAULT '',
      color NULL, pinned INTEGER DEFAULT 0, status DEFAULT 'published' /* published|pending */, rank REAL,
      x REAL NULL, y REAL NULL, w REAL NULL,                       -- canvas 위치(px)
      att_kind NULL, att_url NULL, att_name NULL, att_mime NULL, att_size INTEGER NULL, att_preview TEXT NULL /* JSON */,
      created_at, updated_at)
comments(id PK, post_id → posts CASCADE, author_id → users, body, created_at)
reactions(post_id → posts CASCADE, user_id → users CASCADE, key TEXT /* like|vote|star|grade|emoji:👍 */, value INTEGER DEFAULT 1, PK(post_id,user_id,key))
uploads(id TEXT PK /* 32 hex */, user_id → users, board_id NULL, name, mime, size, created_at)   -- 파일은 DATA_DIR/uploads/<id> (받는 동안은 .<id>.part)
```
업로드 파일의 수명: 행·파일은 **마지막 참조**(게시물 첨부 `att_url`, 링크/파일 미리보기 `att_preview.image`, 보드 `wallpaper`)가 사라질 때 지워진다 — 게시물 삭제, 섹션을 게시물째 삭제, 첨부 교체·제거, 배경 교체, 보드 삭제(복제 보드는 같은 파일을 공유하므로 마지막 보드가 지워질 때). 아무것도 참조하지 않은 채 24시간이 지난 업로드는 정리 작업이 지운다(§1 운영 참고).
인덱스: posts(board_id, section_id, rank), comments(post_id), board_members(user_id), sessions(expires_at), uploads(board_id), uploads(user_id, created_at).
**순서(rank)**: REAL. 새 게시물/섹션은 `newPostPosition`에 따라 (섹션 내) 최소−1 / 최대+1. 이동은 이웃 두 rank 의 중간값, 간격 < 1e-6 이면 그 목록을 1..n 으로 재번호.
정렬 규칙: `pinned DESC, rank ASC` (캔버스·백채널 제외). 백채널은 `created_at ASC` 고정.

## 4. 권한

실효 역할 `role(board, user)`: 소유자 → `admin`(+owner) / `board_members` 행 → 그 역할 / 그 외 `visibility=link` 이면 `linkAccess` / 아니면 `null`(접근 불가, 404 로 응답해 존재를 숨긴다).

| 동작 | 필요 역할 |
|---|---|
| 보드 보기, 내보내기 | read |
| 댓글 쓰기, 반응 | comment (댓글 `settings.comments=off` 면 댓글 불가, 반응은 `settings.reactions≠none`) |
| 게시물 작성 | write (`approval=true` 이고 역할이 write 면 `status=pending`) |
| 게시물 수정·삭제 | **본인 글**은 write 이상, **남의 글**은 moderate 이상. `approval=true` 이고 역할이 moderate 미만이면 **내용(제목·본문·첨부) 수정은 게시물을 다시 `pending` 으로 돌린다**(아래) |
| 게시물 이동·캔버스 위치 | 본인 글은 write 이상, 남의 글은 moderate 이상 |
| 핀 고정, 승인(pending→published), 남의 댓글 삭제 | moderate |
| 섹션 생성·수정·이동·삭제 | moderate |
| 보드 설정 변경, 구성원 추가·역할 변경·**다른 사람** 제거 | admin |
| 구성원 **본인** 나가기 (`DELETE /boards/:slug/members/<내 id>`) | 구성원이면 누구나(역할 무관). 소유자는 나갈 수 없다(409 `owner_cannot_leave`) |
| 보드 삭제, 소유권 | owner (이 버전은 삭제만) |

**승인 보드의 수정**: `settings.approval=true` 인 보드에서 moderate 미만(실질적으로 write 인 작성자)이 게시물의 제목·본문·첨부를 **실제로 바꾸면**(같은 값을 다시 보내는 것은 변경이 아니다) 그 게시물은 `status=pending` 으로 돌아가고, 새 pending 게시물과 똑같이 moderate 이상·작성자 본인에게만 보인다. 이벤트도 같다: moderate 이상·작성자 연결은 `post.updated`(`status:'pending'`), 그 밖의 연결은 `post.deleted`. 위치(x,y,w)·색·고정·섹션 이동·`/move`·반응은 다시 심사하지 않는다. moderate 이상의 수정, `approval=false` 보드의 수정, 이미 pending 인 글의 수정은 상태를 바꾸지 않는다. 응답의 `post.status` 로 결과를 알 수 있다.

**작성자 숨김(`settings.showAuthor=false`)은 서버가 강제한다.** moderate 미만(link 접속자·read/comment/write 구성원, 비로그인 포함)에게 **남의** 게시물·댓글의 `author` 는 어디서나(REST·내보내기 JSON/CSV·SSE 이벤트) `{ id:0, username:null, displayName:"익명", avatarColor:"#94a3b8", isGuest:true }` 로 바뀐다. **본인 것**은 실제 작성자를 유지한다(`author.id === me.id` 로 `isMine` 을 계산할 수 있다). moderate 이상은 실제 작성자를 본다. 이 설정을 `PATCH /boards/:slug` 로 바꾸면 `board.updated` 가 오므로, 클라이언트는 `settings.showAuthor` 가 바뀐 것을 보면 **스냅샷을 다시 받아야** 이미 가진 게시물의 작성자가 맞춰진다. 접속자 목록(presence)은 이 설정과 무관하게 접속 중인 사람의 이름을 보여 준다. 숨김 보드를 `duplicate{withPosts}` 하면 moderate 미만은 복사된 게시물의 작성자가 **복제한 본인**이 된다(원 작성자를 알아내는 통로를 막기 위해).

pending 게시물은 **moderate 이상과 작성자 본인에게만** 목록·이벤트로 보인다. 게스트(`is_guest=1`)는 일반 사용자와 같은 규칙이되 보드를 만들 수 없다(403 `guest_cannot_create`).
쓰기 요청의 **Origin 헤더가 있고 Host 와 다르면 403 `bad_origin`** (CSRF). 쓰기 본문은 `application/json` (업로드 제외).

## 5. REST API (모든 경로 `/api` 아래, JSON, 쿠키 `edulet_sid` HttpOnly·SameSite=Lax·Path=/)

사용자 JSON `User`: `{ id, username (게스트는 null), displayName, avatarColor, isGuest }`
`/auth/*` 응답(본인)에만 두 칸이 더 있다: `hasPassword`(비밀번호로 로그인할 수 있는가 — Google 로만 만든 계정은 `false`)와 `googleEmail`(연결된 Google 계정의 이메일, 없으면 `null`). **다른 사람에게 가는 JSON(작성자·소유자·구성원·내보내기·SSE)에는 절대 없다.**
**`username`(로그인 이름)은 본인과 그 보드의 admin 에게만 실제 값**이고, 그 밖의 보는 사람에게는 `null` 이다(게시물·댓글의 `author`, 보드의 `owner`, 내보내기, SSE 이벤트 모두). `/auth/*` 응답은 항상 본인이므로 그대로 온다. admin 의 구성원 목록(`GET /boards/:slug/members`, 스냅샷의 `members`, 구성원 추가·수정 응답)은 전원의 `username` 을 담는다. 클라이언트는 `username` 이 `null` 이면 "@아이디" 표시를 생략한다(게스트와 구별할 필요가 있으면 `isGuest` 를 쓴다).

### 인증
- `GET  /config` → `{ allowRegister, maxUploadMb, linkPreview, google, googleDomains, share, backup, version }` (`google`: Google 로그인이 켜졌는가 · `googleDomains`: 켜졌고 도메인 제한이 있을 때만 그 목록, 아니면 `[]`. 클라이언트 id 는 내보내지 않는다. `share`·`backup`: 아래)
  - **`backup: { available: boolean }`** — 이 요청이 **"서버 PC 의 운영자"**(`localOperator`, 아래 "저장하기·불러오기")이면 `true`. 화면은 `true` 일 때만 저장하기·불러오기 메뉴를 보인다. 공개 정보지만 불리언 하나뿐이다. 데모 워커는 항상 `{ available: false }`(§12).
  - **`share: { origin: string|null, lan: string[] }`** — 공유 링크·QR 의 기준 주소를 정하는 데 쓴다(`server/share.js`). `origin` = `PUBLIC_URL`(원점만, 예 `https://edulet.example.com`)이 있으면 그 값, 없으면 `null`. **`PUBLIC_URL` 의 호스트가 이 PC 자신(`localhost`·`127.x`·`[::1]`, Google 로그인 시험용으로 흔하다)이면 공개 주소로 치지 않아** `origin` 은 `null` 이고 아래 조건 1 도 참으로 본다(그 값이 모든 공유 링크·QR 을 `localhost` 로 못 박지 않도록). `lan` = 같은 네트워크의 다른 기기가 열 수 있는 이 서버의 주소들(`http://192.168.0.12:3000` 꼴 — 포트 포함, 끝 슬래시 없음). **다음 네 조건이 모두 참일 때만** 채우고 아니면 `[]`:
    1. 공개 주소(`PUBLIC_URL`)가 없다(자기 PC 를 가리키는 값은 없는 것으로 본다). 공개 주소가 있으면 `origin` 이 대신한다.
    2. `HOST` 가 loopback 전용(`127.0.0.1`·`127.x`·`localhost`·`::1`)이 아니다(`0.0.0.0`·`::`·특정 NIC 주소).
    3. 요청의 `Host` 헤더 호스트명이 정확히 `localhost`·`127.x.x.x`·`[::1]` 이다(포트는 있어도 됨, 대소문자 무시) — 교사가 이 PC 에서 localhost 로 열었을 때만. 다른 기기·도메인·DNS 리바인딩 페이지에는 서버의 내부 주소를 알려 주지 않는다.
    4. 접속 주소(소켓 상대방)가 loopback(`127.x.x.x`·`::1`·`::ffff:127.x.x.x`)이다. **`TRUST_PROXY=1` 이면 이 조건은 항상 거짓이다** — 그 설정은 "앞에 프록시가 있다"는 선언이라 소켓 상대방은 프록시이지 화면 앞의 사람이 아니다(같은 PC 에서 도는 프록시가 낯선 사람을 `127.0.0.1` 로 중계할 수 있다). **여기에 더해 프록시·CDN·터널이 붙이는 헤더가 하나라도 있으면 `TRUST_PROXY` 와 상관없이 loopback 이 아닌 것으로 본다**: `X-Forwarded-*`·`Forwarded`·`Via`·`X-Original-Forwarded-For`·`X-Real-IP`·`X-Client-IP`·`Client-IP`·`Proxy-Client-IP`·`WL-Proxy-Client-IP`·`X-Originating-IP`·`X-Remote-IP`·`X-Remote-Addr`·`X-ProxyUser-IP`·`True-Client-IP`·`Fastly-Client-IP`·`Fly-Client-IP`·`X-Cluster-*`·`X-Azure-*`·`X-ARR-*`·`CF-*`·`X-Envoy-*`·`X-Amz*`·`X-Appengine-*`·`X-Vercel-*`·`X-MS-*`·`X-Nginx-*`·`ngrok`·`X-Tunnel*`·`CDN-Loop`·`X-Host`·`X-Original-Host`·`X-Original-URL`·`X-Rewrite-URL`·`Front-End-Https`·`Proxy-Connection` 등(`server/share.js` 의 `PROXY_HEADER`). **이것은 블랙리스트라 완전할 수 없다**: 헤더를 하나도 붙이지 않는 같은 PC 의 포워더(`netsh interface portproxy`·`ssh -R`·socat·단순 TCP 중계)로 들어온 요청은 화면 앞의 운영자와 구별되지 않는다 — 프록시·터널 뒤에 서버를 둘 때는 `PUBLIC_URL` 을 설정한다(저장하기·불러오기 메뉴가 꺼진다). (보수적 판정 — 틀린 "아니오" 는 교사가 힌트를 못 보는 것뿐이고, 틀린 "예" 는 낯선 사람에게 서버 내부 주소를 알리는 것이다.)
    - 목록 내용: `os.networkInterfaces()` 의 IPv4 중 `internal=false`·링크 로컬(`169.254/16`)·멀티캐스트가 아닌 것. 가상 어댑터(`vEthernet`·`VirtualBox`·`VMware`·`WSL`·`docker`·`Hyper-V`·`Tailscale`·`ZeroTier`·`Bluetooth` 등의 이름)는 실제 어댑터 뒤로 보내고, 그 안에서 사설 대역 `192.168/16` → `10/8` → `172.16/12` → 그 밖 순으로 정렬(같으면 OS 순서), 중복 제거, **최대 4개**. 포트는 요청이 들어온 소켓의 로컬 포트(`req.socket.localPort`)이지 `config.port` 가 아니다(`PORT=0` 이나 포트 매핑에서도 맞도록). `HOST` 가 특정 IPv4 주소이면 그 주소 하나만(그 서버는 다른 NIC 로는 답하지 않는다), 호스트 이름·IPv6 주소이면 `[]`(어느 NIC 인지 알 수 없다). NIC 조회가 실패하면 `[]`(오류 아님).
    - 데모 워커의 `GET /config` 는 `share: { origin: null, lan: [] }`(+ `demo: true`) 를 같이 낸다(§12).
- `GET  /health` → `{ ok:true }`
- `GET  /auth/me` → `{ user: User|null }`
- `POST /auth/register {username,password,displayName}` → `{ user }` (+쿠키). 중복 409 `username_taken`
- `POST /auth/login {username,password}` → `{ user }`. 실패 401 `bad_credentials` (사용자 없음/비번 틀림 구분 금지, 해시 비교 시간 균일화). **계정별 실패 제한**: 같은 사용자명(소문자로 정규화, 계정이 있든 없든)으로 15분 안에 `LOGIN_FAIL_MAX`(10)번 실패하면 그 이름은 잠긴다 — 잠긴 동안은 올바른 비밀번호여도 비밀번호를 확인하지 않고 429 `rate_limited`(+`Retry-After`)를 준다. 존재하지 않는 이름도 똑같이 잠기므로 응답으로 계정 존재를 알 수 없다. 로그인에 성공하면 그 이름의 실패 횟수가 지워진다. (남이 일부러 실패를 쌓아 계정을 15분간 잠글 수 있다는 점은 이 설계의 알려진 대가다.)
- `POST /auth/guest {displayName}` → `{ user }` (+쿠키, 게스트 계정 생성). 이미 로그인 상태면 표시 이름만 갱신
- `POST /auth/logout` → `{ ok:true }`
- **Google 로그인** — OAuth 2.0 인증 코드 흐름 + PKCE(S256), **전부 서버에서** 한다(브라우저에 Google 스크립트를 싣지 않으므로 CSP 는 그대로). 로그인·가입의 두 경로(`start`·`callback`)는 **JSON 이 아니라 302** 로 끝나고, 연결·해제(`link`·`unlink`)는 JSON 이다.
  - `GET /auth/google/start?next=<경로>` → `accounts.google.com` 으로 302. 요청 한 번마다 `state`·`nonce`·PKCE `code_verifier`(48바이트 무작위)를 만들어 **쿠키 `edulet_oauth`**(HttpOnly·SameSite=Lax·`Path=/api/auth/google`·10분)에 담는다 — 서버 메모리엔 아무것도 두지 않는다. 쿠키 값은 `base64url(JSON{s,n,v,r,x,m,u,e})` + `.` + `base64url(HMAC-SHA256(클라이언트 시크릿, "edulet-oauth-flow|" + 앞 base64url))` — **브라우저는 나를 수 있어도 만들 수는 없다**(서명이 틀리면 `google_state`, Google 은 부르지도 않는다. 그래서 남이 `redirect_uri`·verifier 를 마음대로 골라 우리 시크릿으로 토큰 교환을 시킬 수 없다). 쿠키가 요청한 브라우저에 묶여 있어서 남이 만든 `code` 를 내 브라우저로 흘려 넣는 로그인 CSRF 도 막힌다. 클라이언트 시크릿과 verifier 는 Google 주소에 실리지 않는다(`code_challenge` 만). 요청 범위 `openid email profile`, `prompt=select_account`, 허용 도메인이 **하나뿐이고 gmail 이 아니면** `hd` 힌트(힌트일 뿐 — 판정은 아래 `hd` 검사). `mode` 같은 인자는 없다(연결은 아래 POST).
  - `GET /auth/google/callback?code&state` → 쿠키의 서명과 `state`(시간 상수 비교)를 확인하고, `code` 를 `https://oauth2.googleapis.com/token` 에 시크릿·verifier 와 함께 보내 ID 토큰을 받는다(TLS 로 Google 에서 직접 받은 토큰이므로 서명 검증은 하지 않고 **클레임**을 검사: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`} · `aud` = 클라이언트 id · `exp` 미경과(시계 오차 1분) · `nonce` 일치 · `sub` 문자열 ≤255 · `email` 형식 · `email_verified`). 흐름 쿠키는 결과와 상관없이 즉시 지운다(1회용). 쿠키는 무상태라 브라우저가 남겨 둔 사본을 다시 보낼 수 있으므로, **서버가 응답한 `state` 를 기억해 한 번 시작한 흐름은 한 번만 답을 받는다**(두 번째는 `google_state`, Google 을 부르지 않는다 — 재시작하면 잊지만 쿠키 수명 10분 안의 한 번 더가 최악이다). 토큰 교환은 우리 시크릿을 쓰는 호출이라 **서버 전체에서 분당 1200회**로 묶는다(넘으면 `google_rate`; 접속 주소별 `GOOGLE_RATE` 와 별개 — 위조·재사용 쿠키는 그 앞에서 걸러져 이 예산을 쓰지 않는다).
  - **`GOOGLE_DOMAINS` 가 있으면**: `hd` 클레임(Workspace 도메인)이 목록에 있어야 한다. `hd` 가 없는 일반 계정은 이메일 도메인이 `gmail.com`/`googlemail.com` 이고 그것이 목록에 있을 때만 통과 — **이메일 도메인만 보고 학교 계정으로 믿지 않는다.** 로그인·연결 둘 다 적용.
  - 로그인(`start`→`callback`): `google_sub` 로 계정을 찾는다. 있으면 로그인(이메일이 바뀌었으면 갱신, **표시 이름은 건드리지 않는다**). 없으면 새 계정: `is_guest=0`, `password_hash=NULL`, 표시 이름 = Google 이름(제어 문자 제거·40자까지, 없으면 "구글 사용자" — **이메일 앞부분은 쓰지 않는다**, 학교에선 학번인 경우가 많은데 표시 이름은 공개다), **`username` = `g-` + 무작위 12자리 16진수**(보드 구성원 초대에 쓰는 아이디 — 이메일 주소를 공개 이름으로 만들지 않으려고 일부러 무작위). `ALLOW_REGISTER=0` 이면 새 계정은 만들지 않고 이미 연결된 계정만 로그인된다. **이메일로 기존 비밀번호 계정에 자동으로 붙이지 않는다**(연결은 아래 `link` 로만). 기존 세션(게스트 포함)은 지우고 새 세션 쿠키를 준다(`/auth/login` 과 같음).
  - `POST /auth/google/link {currentPassword, next?}` → `{ url }` + 흐름 쿠키(`Set-Cookie`). 로그인한 **비밀번호 계정**만(비게스트·`password_hash` 있음), 이미 Google 이 연결돼 있으면 409 `google_already_linked`, 꺼져 있으면 404 `google_disabled`, 로그인 안 했으면 401, 게스트·비밀번호 없는 계정은 403. **현재 비밀번호를 먼저 확인한다**(§5 `PATCH /auth/me` 의 `newPassword` 와 같은 확인·같은 한도: IP 당 인증 분당 20회 + 계정별 15분 `LOGIN_FAIL_MAX` 번 틀림 → 429; 틀리면 401 `bad_credentials`. 시도는 **느린 해시를 돌리기 전에** 세고 맞으면 지운다 — 동시에 날린 추측이 한꺼번에 검사를 통과하지 못하게) — 탈취된 세션만으로 공격자 자신의 Google 계정을 "두 번째 출입구"로 심어 두는 길을 막기 위해서다(소유자가 비밀번호를 바꿔 다른 세션을 지워도 남는 뒷문이 되므로). `url` 은 Google 주소이고 페이지가 그리로 이동한다. 같은 출처 POST 만 받는다(`bad_origin`). 돌아왔을 때(`callback`)는 **시작할 때와 같은 사용자가 로그인돼 있는지** 다시 확인(`google_need_login`), 그 Google 계정이 이미 다른 사용자에게 연결돼 있으면 `google_taken`. 성공하면 세션은 그대로, 플래시 `google_linked`.
  - `POST /auth/google/unlink {currentPassword}` → `{ user }`. 연결을 푼다(`google_sub`·`google_email` 삭제). 같은 비밀번호 확인·한도. **비밀번호가 있는 계정만**(없으면 풀었다가 들어올 방법이 없어지므로 403), 연결이 없으면 409 `google_not_linked`. **푼 사람 말고 그 계정의 다른 모든 세션은 지워지고 그 세션들의 열린 SSE 연결도 닫힌다**(비밀번호 변경과 같음 — 연결 해제는 "누가 내 계정에 Google 을 심었나" 싶을 때의 복구 동작이다). 푼 뒤 같은 Google 계정으로 로그인하면 새 계정이 만들어진다.
  - **돌아가는 곳 `next`**: 이 사이트 안의 경로만 — `/` 로 시작하고 **인쇄 가능한 ASCII**(`0x21–0x7e`, 역슬래시 제외)만, 500자 이하, `//` 로 시작하지 않고, `/api/…`·`/uploads/…` 가 아니어야 한다(아니면 `/` — `/./api`·`/%2e/api` 처럼 URL 파서가 정리해서 보는 경로로 판단한다). 한글 등은 브라우저가 퍼센트 인코딩해서 보내므로 정상 흐름은 영향이 없고, 손으로 만든 비ASCII 주소가 가입 직후 리디렉션을 깨뜨리는 일(헤더에 못 쓰는 문자)을 막는다. 성공이든 실패든 `next` 로 302 하고 **쿠키 `edulet_flash`**(JS 가 읽는다 — HttpOnly 아님, `Path=/`, 60초)에 결과 코드를 한 단어로 싣는다: 성공 `google_ok`(기존 계정) · `google_new`(방금 가입) · `google_linked`; 실패 `google_denied`(Google 에서 취소) · `google_state`(쿠키 없음/서명 불량/만료/state 불일치) · `google_failed`(토큰 교환 실패·클레임 불량·10초 시간 초과) · `google_domain` · `google_unverified` · `google_disabled`(꺼져 있음) · `google_register_closed` · `google_taken` · `google_already_linked` · `google_need_login` · `google_rate`. 프런트(`showAuthFlash`)가 읽고 지우며 코드마다 한국어 안내를 보여 준다. 예상 못 한 서버 오류만 JSON 500(그 로그에는 `code`·`state` 가 든 쿼리를 남기지 않는다).
  - 쿠키 `Secure` 는 세션 쿠키와 같은 규칙(§1 `COOKIE_SECURE`) — **`PUBLIC_URL` 이 https 이면 `auto` 에서도 `Secure`** 가 붙는다. 배포 가정: 같은 상위 도메인의 **믿을 수 없는 형제 서브도메인이 없다**(그런 곳은 이 쿠키들을 심을 수 있다 — 세션 쿠키도 마찬가지). Google 토큰은 저장하지 않는다 — 로그인 한 번에만 쓰고 버린다. 프로필 사진은 쓰지 않는다.
  - 사용자 JSON 의 `username` 이 `g-…` 여도 비밀번호 로그인은 항상 `bad_credentials`(해시가 없으므로), `PATCH /auth/me` 의 `newPassword` 는 403.
- `PATCH /auth/me {displayName?, avatarColor?, currentPassword?, newPassword?}` → `{ user }`. 사용자당 분당 30회(429 `rate_limited`). `newPassword` 가 있으면(scrypt 를 돌린다) IP 당 인증 한도(분당 20회)도 함께 쓰고, 계정별로 틀린 `currentPassword` 가 15분에 `LOGIN_FAIL_MAX` 번 쌓이면 잠긴다(429 `rate_limited`). 비밀번호를 바꾸면 **다른 모든 세션이 삭제되고 그 세션들의 열린 SSE 연결도 즉시 닫힌다**(바꾼 세션의 연결은 유지).
- 비밀번호는 `crypto.scrypt`(솔트 16B, N=2^15 이상) 로 `scrypt$N$r$p$salt$hash` 저장. 세션 토큰 32B 랜덤, DB 에는 SHA-256 만 저장. 로그인·가입·게스트: IP 당 분당 20회 제한(429 `rate_limited`).

### 보드
`Board` JSON: `{ id, slug, title, description, format, wallpaper, font, colorScheme, visibility, linkAccess, settings, owner: User, createdAt, updatedAt }`
- `GET  /boards` → `{ boards: [ { ...Board, role, postCount, memberCount } ] }` (내가 소유·구성원인 것, `updatedAt DESC`) — 로그인 필수 401
- `POST /boards {title, description?, format?, template?}` → `{ board }` (소유자 admin). `template` 은 섹션(과 형식)을 미리 채운다:
  `blank`(wall, 섹션 없음) · `kwl`(shelf: 알고 있는 것 / 알고 싶은 것 / 배운 것) · `retro`(shelf: 잘한 점 / 아쉬운 점 / 시도할 점) · `training`(rows: 1부 / 2부). 명시한 `format` 이 우선.
- `GET  /boards/:slug` → 스냅샷
  `{ board, role, isOwner, sections:[Section], posts:[Post], members?:[Member] (admin 만), presence:[PresenceUser] }` — `presence` 는 최대 50명(나머지 수는 `hello`/`presence` 이벤트의 `more`). `posts` 는 viewer 에 맞게 가공된다(작성자 숨김·`username`, §4·§5 User). **스냅샷은 캐시하지 않는다**(`mine`·pending·작성자 가공이 viewer 마다 달라서). 대신 보드당 게시물 수 상한(§11)과 쓰기 한도로 크기를 묶는다.
  접근 불가·없음 → 404 `not_found`. 로그인 안 한 사용자도 `visibility=link` 면 읽기 가능(`role` 은 linkAccess).
- `PATCH /boards/:slug {title?, description?, format?, wallpaper?, font?, colorScheme?, visibility?, linkAccess?, settings?}` → `{ board }` (admin, `settings` 는 병합). 형식을 `shelf/rows` 로 바꿀 때 섹션이 0개면 "섹션 1" 을 만들고 섹션 없는 게시물을 거기로 옮긴다(이 변경은 `section.created`·`post.moved` 이벤트로도 알린다).
- `DELETE /boards/:slug` (owner) → `{ ok:true }` (업로드 파일 정리 포함 — 다른 보드가 공유하지 않는 파일만, §3)
- `POST /boards/:slug/duplicate {withPosts?: boolean}` → `{ board }` (read 이상이면 누구나, 내가 소유자. 제목 "… 사본". 게시물 복사 시 작성자는 원 작성자 유지(단, `showAuthor=false` 보드를 moderate 미만이 복사하면 작성자는 복제한 본인, §4), 반응·댓글은 복사 안 함, 업로드 첨부는 같은 파일 URL 공유)
- `GET  /boards/:slug/members` / `POST /boards/:slug/members {username, role}` / `PATCH /boards/:slug/members/:userId {role}` (admin) / `DELETE /boards/:slug/members/:userId` (admin 은 누구든, **구성원은 본인(`userId` = 내 id)만** — §4). `Member = { user: User, role }`. 소유자는 목록에 `role:"admin", isOwner:true` 로 항상 첫 줄. 구성원 변경 시 `members.updated` 이벤트. 추가(`POST`)는 사용자명 조회이기도 하다(없으면 404 `user_not_found`, 이미 구성원이면 409 `already_member`, 소유자면 409 `already_owner` — admin 에게만 보인다): 사용자당 분당 `MEMBER_RATE`(30)번, 넘으면 429 `rate_limited`. 본인 나가기 후 그 사람은 `linkAccess` 역할로 돌아가고(비공개 보드면 404), 열린 SSE 연결은 접근이 없으면 닫힌다. 비구성원이 호출하면 404 `not_found`, 비로그인은 401.
- `GET  /boards/:slug/export?format=json|csv` → 파일 다운로드(`Content-Disposition: attachment`). CSV 는 UTF-8 BOM, 컬럼: `섹션,작성자,제목,본문,첨부,링크,좋아요,댓글수,작성시각`. 수식 주입 방지로 `= + - @` 로 시작하는 셀 앞에 `'` 를 붙인다.
  - **HTML 오프라인 파일은 클라이언트가 만든다(서버 API 없음, 데모 워커도 같다)**: 화면이 위 `format=json` 과 거기서 가리키는 `/uploads/…` 파일만 읽어(보는 사람이 이미 볼 수 있는 것뿐) 스크립트가 0줄인 .html 하나(`edulet-<slug>-YYYYMMDD.html`)로 묶는다. 구현은 `public/js/lib/export-html.js`(DOM 없는 문자열 빌더, 시험 `test/export-html.test.js`)와 `export-offline.js`(받기·그림 줄이기·한도·취소). 모든 사용자 값은 escape, 링크는 http(s) 절대 주소만, 원격 이미지는 담지 않고, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` 를 넣는다. 작성자 숨김(`showAuthor=false`) 보드는 내보내는 사람이 moderate 이상이어도 이름을 담지 않는다.
  - **용량 방어**(상수 `EXPORT_LIMITS`): 그림은 긴 변 1600px 이하로 줄여(WebP/JPEG, 옵션 "원본 크기"), 파일 하나 15MB·합계 150MB(base64 전) 를 넘는 것과 받지 못한 것은 건너뛰되 파일 안(카드 자리와 맨 위 목록)과 만든 뒤 요약에 이유와 함께 적는다. 순차(동시 3개) 처리에 진행률·취소(AbortController)가 있다. 글·댓글 글자(그림 제외)는 `textBytes` 100MB 를 넘으면(받기 전에 JSON 으로 추정, 만드는 중에도 누적 확인) 한국어 안내와 함께 **파일을 만들지 않는다**. 만드는 일은 약 1MB 마다 화면에 양보하고 `signal` 을 본다.
  - **그림 처리**(`public/js/lib/image-bytes.js`, 시험 `test/export-hardening.test.js`): 디코딩 **전에** 헤더(PNG IHDR·JPEG SOF·GIF·WebP VP8/VP8L/VP8X)에서 크기를 읽어 40메가픽셀 초과(압축 폭탄)는 "원본 크기"에서도 건너뛴다(`too_large`). 읽을 수 없는 헤더는 `undecodable`. 디코딩은 한 번에 하나(받기는 3개). 기본 모드에서는 **위치 정보(EXIF GPS·XMP)가 파일에 남지 않는다**: JPEG 는 EXIF/XMP/IPTC/주석/EOI 뒤 자투리를 잘라 내고(방향 표식만 남김) 다시 인코딩이 필요하면 canvas 로, PNG 는 text/EXIF/time 청크를 잘라 내며, 움직이는 PNG/WebP 는 canvas 로 정지된 그림이 된다(GIF 는 그대로). 디코딩이 안 될 때는 잘라 낸 원본을 1MB 이하일 때만 담고(메타데이터를 못 자르는 파일은 담지 않음) 아니면 `undecodable`. "원본 크기"는 원본 바이트 그대로라 위치 정보가 들어 있고 화면 안내가 그렇게 말한다. 파일 하나의 실패는 그 파일만 `failed` 로 건너뛰고(영어 예외 문장은 화면에 내지 않는다) 나머지는 계속한다.
  - **주소**: `/uploads/<32hex>/<이름>`·데모 시드 `/uploads/seed-<n>/<이름>` 만 받는다(이름이 점뿐이면 제외). 그 밖의 `/uploads/…` 는 요청하지 않고 "담지 못한 파일"로 올리며, `/uploads/` 밖의 그림만 "외부 그림"이라고 한다. 본문 링크 주소는 2048자까지만(넘으면 글자), 끝의 문장부호 떼기는 선형 시간(`markdown.js` 와 `export-html.js` 같은 규칙).

### 섹션 (`Section = { id, boardId, title, rank }`)
- `POST /boards/:slug/sections {title, beforeId?}` → `{ section }`
- `PATCH /sections/:id {title}` → `{ section }`
- `POST /sections/:id/move {beforeId: number|null}` → `{ section }` (null = 맨 끝)
- `DELETE /sections/:id?posts=delete|move` → `{ ok:true }` (`move`(기본) = 같은 보드의 첫 다른 섹션으로, 없으면 `sectionId=null`)

### 게시물
`Post` JSON:
```
{ id, boardId, sectionId (null 가능), author: User, title, body, color, pinned, status, rank, x, y, w,
  attachment: null | { kind: image|file|link|video, url, name, mime, size,
                       preview?: { title, description, image, site, embedUrl? } },   // link/video 일 때
  commentCount,
  reactions: { like:{count,mine}, vote:{count,mine}, star:{count,mine}, grade:{count,avg,mine}, emoji:{ "👍":{count,mine}, ... 사용된 것만 } },
  createdAt, updatedAt }
```
- `POST /boards/:slug/posts {title?, body?, sectionId?, color?, attachment?, x?, y?, w?}` → `{ post }`. 제목·본문·첨부가 모두 비면 400 `empty_post`. `attachment` 입력: `{kind:'image'|'file', uploadId}`(업로드 결과) 또는 `{kind:'link'|'video', url}`(서버가 미리보기를 채움; 미리보기 실패해도 저장은 성공, `preview` 는 `{title:url}` 정도) 또는 `{kind:'image', url:'https://…'}`(외부 이미지 주소). `javascript:`·`data:` 등 http(s) 가 아닌 URL 은 400 `bad_url`. 보드가 이미 `BOARD_MAX_POSTS`(5000) 개(pending 포함)면 409 `board_full`. 권한·`approval` 상태·섹션은 링크 미리보기 등 `await` 가 끝난 **뒤** 트랜잭션 안에서 다시 판정한다(그 사이 구성원에서 빠졌으면 403/404, 보드가 지워졌으면 404, 세션이 폐기됐으면 401 — 저장하지 않는다).
- `PATCH /posts/:id {title?, body?, sectionId?, color?, pinned?, attachment?: object|null, x?, y?, w?}` → `{ post }` (같은 재판정을 한다. `approval` 보드에서 moderate 미만이 내용을 바꾸면 `post.status` 가 `pending` 으로 돌아온다 — §4)
- `DELETE /posts/:id` → `{ ok:true }`
- `POST /posts/:id/move {sectionId: number|null, beforeId: number|null}` → `{ post }` (같은 섹션 안 순서 변경 포함. `beforeId=null` = 그 섹션 맨 끝. `beforeId` 가 **내게 보이지 않는** 게시물(남의 pending)이면 존재하지 않는 id 와 똑같이 400 `bad_request` 다)
- `POST /posts/:id/approve` → `{ post }`
- `GET  /posts/:id/comments` → `{ comments:[Comment] }`, `Comment = { id, postId, author: User, body, createdAt }` (오래된 순)
- `POST /posts/:id/comments {body}` → `{ comment, commentCount }`
- `DELETE /comments/:id` → `{ commentCount }` (본인 또는 moderate). 없는 댓글과 **내가 볼 수 없는 보드·게시물의 댓글**은 똑같이 404 `not_found`("댓글을 찾을 수 없어요.").
- `PUT  /posts/:id/reactions {kind:'like'|'vote'|'star'|'grade'|'emoji', value?}` → `{ reactions }` (내 `mine` 포함). `like/vote/star` 토글. `grade` 는 `value` 1–10 설정, 같은 값을 다시 보내거나 0 이면 취소. `emoji` 는 `value` 가 EMOJIS 중 하나, 토글(여러 개 가능). 보드의 `settings.reactions` 와 `kind` 가 다르면 400 `reaction_disabled`.

### 업로드·링크
- `PUT  /uploads?board=<slug>&name=<파일이름>` — 본문은 **원시 바이트**, `Content-Type` 은 파일 MIME. write 이상. 한도 `MAX_UPLOAD_MB`(초과 413 `too_large`, 본문 읽다가 끊는다). 파일 이름은 정규화(경로 구분자 제거, 길이 ≤ 100). 이미지(png/jpeg/gif/webp)는 **앞부분 매직 바이트로 검증**하고 MIME 을 그 결과로 확정한다(SVG 거부). → `{ id, url:"/uploads/<id>/<name>", name, mime, size, kind:'image'|'file' }`
  본문은 **임시 파일(`DATA_DIR/uploads/.<id>.part`)로 스트리밍**하며 바이트를 세다가 한도를 넘으면 끊는다(메모리에 통째로 쌓지 않는다). 다 받은 뒤 검증하고 `<id>` 로 이름을 바꾼다. 30초 동안 데이터가 없으면 408 `request_timeout`. 받는 동안 보드·역할·세션이 바뀌었으면(구성원에서 빠짐·보드 삭제·로그아웃) 저장하지 않고 403/404/401 을 준다. 한도(§11): 동시 업로드 서버 6·사용자 2 → 429 `busy`, 사용자당 10분 30회 → 429 `rate_limited`, 사용자당 24시간 300MB → 429 `quota_exceeded`(모두 한국어 메시지 + `Retry-After`).
- `GET  /uploads/<id>/<name>` (경로가 `/api` 밖) — 인증 없이 제공(id 가 추측 불가능한 비밀 주소). 이미지는 inline, 그 외는 `Content-Disposition: attachment`. 항상 `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: public, max-age=31536000, immutable`. Range 요청 지원(영상·PDF).
- `POST /link-preview {url}` → `{ url, kind:'link'|'video', title, description, image, site, embedUrl? }` (로그인 필수). 서버가 가져오는 쪽이라 **SSRF 방어 필수**: http(s) 만, 모든 DNS 결과를 검사해 루프백·사설·링크로컬·CGNAT·멀티캐스트·ULA·`169.254.169.254` 거부(IPv6 에 IPv4 가 들어 있는 `::ffff:a.b.c.d`·`::ffff:0:a.b.c.d`·`64:ff9b::/96`·6to4 는 **들어 있는 IPv4 주소**로 판정), 연결 시 검사한 주소로 고정(`lookup` 훅), 리다이렉트 최대 3회(매번 재검사), 타임아웃 5초, 본문 512KB 까지만 읽고 **앞 128KB 만 파싱**, `text/html` 만 파싱(OG/Twitter/`<title>`/description; 역추적 정규식 없는 선형 스캐너, `<meta>`/`<title>` 후보 1000개·태그당 4KB 한도).
  **한도는 미리보기 서비스 안에 있어** 게시물 생성·수정의 링크 첨부도 같은 한도를 쓴다(우회 불가): 사용자당 분당 20회(캐시 적중 포함; 엔드포인트는 429 `rate_limited`), 대상 호스트당 분당 60회의 실제 외부 요청, 동시 외부 요청 8개, 같은 URL 의 동시 요청은 한 번만 가져온다. 호스트·동시 한도에 걸리면 `/link-preview` 는 가져오지 못한 페이지와 같은 **최소 미리보기**(`title` = URL)를 200 으로 주고, 게시물 저장은 한도에 걸려도 실패하지 않고 `{title:url}` 미리보기를 저장한다.
  **차단 응답의 균일성**: 호스트 *이름*이 사설 주소로 풀리는 경우는 "가져올 수 없는 페이지"와 똑같이(200, 최소 미리보기) 답한다 — 안 그러면 내부 DNS 이름을 열거할 수 있다. URL 글자만으로 정해지는 차단(리터럴 IP, `localhost`·`*.localhost`, 자격증명, http(s) 아닌 스킴)은 그대로 400 `blocked_url` 이다. YouTube(`youtube.com/watch`, `youtu.be`, `shorts`) → `kind:'video'`, `embedUrl:https://www.youtube-nocookie.com/embed/<id>`, 썸네일 `https://i.ytimg.com/vi/<id>/hqdefault.jpg`. Vimeo 도 같은 방식(`player.vimeo.com/video/<id>`). 영상의 제목·채널명은 공개 oEmbed 엔드포인트(`youtube.com/oembed`, `vimeo.com/api/oembed.json`; 호스트 고정, 검증된 영상 id 만 보냄, 같은 SSRF 방어 경로)로 가져오고 실패하면 페이지 HTML 로 되돌아간다. `EDULET_LINK_PREVIEW=0` 이면 외부 요청 없이 호스트명만 돌려준다. 결과는 메모리에 10분 캐시.

### 저장하기·불러오기 (백업) — `server/backups.js`, `server/restore.js`, `server/backup.js`
화면 메뉴 "저장하기"(= 백업 만들기)와 "불러오기"(= 이전 백업 중 하나를 골라 바로 쓰기). 백업 파일의 형식·안전 규칙은 §1 "백업". 시험: `test/restore.test.js`(임시 폴더·임의 포트만 — 진짜 `data/`·`backups/`·포트 3000 은 건드리지 않는다).

**누가 쓸 수 있나 — "서버 PC 의 운영자"** (`localOperator(app, req)`, `server/share.js`; `share.lan` 을 채우는 조건과 같은 판정이다): `TRUST_PROXY` 가 꺼져 있고 ∧ `PUBLIC_URL`(자기 PC 를 가리키는 값은 없는 것으로 봄)이 없고 ∧ 프록시·터널 헤더(§5 `/config` 의 목록 — 블랙리스트이며 한계도 거기 적혀 있다)가 없고 ∧ `Host` 헤더가 `localhost`·`127.x.x.x`·`[::1]` 이고 ∧ 소켓 상대방이 loopback. 저장하기·불러오기 API 는 전부 이 문을 **먼저** 지난다(`backupGate`):
1. `localOperator` 가 아니면 403 `backup_local_only` ("저장하기·불러오기는 서버를 켠 PC 에서 localhost 주소로 열었을 때만 쓸 수 있어요.").
2. DB 에 비게스트 사용자(`is_guest=0`)가 하나라도 있으면 요청자가 로그인한 **비게스트**여야 한다 — 아니면 403 `member_required` ("계정으로 로그인한 뒤에 쓸 수 있어요." — 실제 판정은 "가입한 비게스트 계정"이지 "교사"가 아니다). **401 을 쓰지 않는다**(프런트 `api.js` 가 401 을 "세션 만료"로 보고 로그아웃시킨다). 비게스트가 한 명도 없으면(새 PC 에서 처음 복원) 로그인 없이 허용.
3. 변경 요청(POST)은 기존 Origin 검사(`bad_origin`)를 그대로 받는다.

**신뢰 모델의 한계(솔직하게)**: 문은 "서버 PC 앞에 앉은 사람 + 가입한 계정"이다. 서버 PC 를 학생과 함께 쓰는 **공용 PC** 라면 그 PC 에서 가입한 누구나 저장·불러오기를 할 수 있다(저장본에는 모든 사용자의 보드와 비밀번호 해시가 들어 있고, 불러오기는 모든 데이터를 바꾼다) — 공용 PC 에서는 `ALLOW_REGISTER=0` 을 권장한다. 불러오기가 읽는 `backups/` 폴더에 파일을 쓸 수 있는 사람은 이미 파일 시스템 권한이 있는 사람이라 이 문서는 그를 막으려 하지 않는다(예: 저장본의 `users.password_hash` 에 큰 scrypt 비용을 심어 두면 그 계정으로 로그인할 때 느려진다 — 기존 `auth.js` 동작). 교체는 동기라서 아주 큰 DB 에서는 수 초 동안 서버가 멈춘다(그동안 읽기도 막힌다) — 워커 스레드화는 하지 않았다. **자동 정리는 없다**: 저장하기·불러오기 직전 안전 저장이 쌓이면 `backups/` 의 용량이 계속 늘어난다(필요 없는 폴더는 탐색기에서 지운다). 불러오는 도중 프로세스가 죽으면 행이 없는 업로드 파일(`data/uploads` 의 `.…​.part` 포함)이 남을 수 있다 — 무해하다(`.part` 는 1시간 뒤 정리, 나머지는 어느 행도 가리키지 않는다).

**백업 id** = 폴더 이름 `edulet-YYYYMMDD-HHMMSS[-n]`(정규식 `^edulet-\d{8}-\d{6}(?:-\d+)?$`, `.partial` 제외 — 이 모양이 아니면 어떤 경로·긴 문자열·`..`·`/`·`\`·드라이브 문자도 400 `bad_request`, 파일 시스템은 건드리지 않는다). 폴더는 `backupDir` 의 **직계 자식**이고 심볼릭 링크가 아니며, 일반 파일 `edulet.db` 와 `BACKUP-INFO.txt`(둘 다 링크 아님)가 있어야 "정상 백업"으로 목록에 나온다(아니면 조용히 제외). **백업 폴더는 읽기 전용으로만 다룬다** — 그 안에서 SQLite 를 열면 `-wal`/`-shm` 이 생겨 백업이 바뀌므로, 읽을 때는 항상 OS 임시 폴더로 복사해서 연다. 응답에 절대 경로는 없다.

`item = { id, createdAt, kind: 'manual'|'before-restore', dbBytes, uploadFiles, warnings: number, summary: { boards, posts, users, latestPostAt } | null }` — `createdAt`·`kind`·`summary` 는 `backup.json` 에서, **없으면(옛 백업)** `createdAt` 은 폴더 이름의 날짜·시각(이 PC 의 지역 시각), `kind` 는 `manual`, `summary` 는 임시 사본을 열어 읽어 채운다(한 번의 요청에 최대 20개까지, 결과는 (id, mtime, size) 키로 메모리 캐시, 못 읽으면 `null`).

- `GET /backups` → `{ items: item[] (최신 먼저, 최대 200), current: { boards, posts, users, latestPostAt }, backupDirName }`. `backupDir` 가 없으면 `items: []`(오류 아님). `.partial`·이름이 안 맞는 항목은 조용히 제외. `backupDirName` = 백업 폴더의 이름(기본 `backups`). 옛 백업(`backup.json` 없음)의 `summary` 를 읽을 때도 **미리보기와 같은 구조 검사**(표·인덱스 외 객체 거부, `boards`·`posts`·`users` 는 진짜 표)를 먼저 하고 `trusted_schema=OFF`·`query_only=ON` 으로 센다 — 거부되면 그 항목의 `summary` 는 `null`(목록은 그대로 나온다). 손으로 만든 3억 행 재귀 뷰가 목록을 멈추게 할 수 없다.
- `GET /backups/:id` (미리보기) → `{ item, boards: [{ title, posts, updatedAt }] (updatedAt 내림차순, 최대 100), warnings: string[], newerThanApp: false }`. 임시 사본(`PRAGMA trusted_schema=OFF`·`query_only=ON` 로 연다)에서 `integrity_check`(일반 연결)=`ok`, 스키마 버전 ≤ 이 서버가 아는 최신(`db.js` 의 `SCHEMA_VERSION` = 마이그레이션 개수), **`sqlite_master` 에 표·인덱스 외의 것(view·trigger)이 없고 `boards`·`posts`·`users` 가 진짜 표**, 필요한 표·열이 다 있음, `foreign_key_check` 비어 있음, **`sqlite_sequence` 의 번호표와 그 표들의 `rowid` 가 정수이고 0 이상 `Number.MAX_SAFE_INTEGER / 2`(≈4.5×10¹⁵) 이하**(아니면 422 "표의 번호표가 비정상이에요" — 하나가 2⁵³ 근처면 복원 뒤 모든 INSERT 가 막힌다)를 확인한다. 사용자(없으면 IP)당 분당 20회, 넘으면 429 `rate_limited`(+`Retry-After`; 데이터베이스 하나를 통째로 복사해 검사하므로). 하나라도 어긋나면 422 `backup_invalid`(한 줄 한국어 이유: 손상 / 더 새로운 Edulet 로 만든 백업 / 필수 표 없음 …), 없으면 404 `backup_not_found`. `warnings` 는 `BACKUP-INFO.txt` 의 경고가 아니라 **이 검사에서 알게 된 것**(업로드 폴더 없음, 참조된 업로드 파일 n개 없음, 옛 스키마라 불러올 때 새 형식으로 바뀜 …).
- `POST /backups` (저장하기) → 201 `{ item, warnings: string[] }`. `backupData({ dataDir, outDir: backupDir })` — 서버의 다른 일은 계속 돈다. 전역 뮤텍스 `app.backupBusy`: 저장·불러오기가 이미 진행 중이면 409 `busy`("다른 저장·불러오기가 진행 중이에요."). 사용자(없으면 IP)당 분당 6회, 넘으면 429 `rate_limited`(+`Retry-After`). `BackupError` → 500 `backup_failed`(한국어 메시지; 스택·내부 예외는 내보내지 않는다). **어떤 응답의 메시지·`warnings` 에도 이 PC 의 폴더가 없다**(`scrubPaths`): 설정된 `data`·`backups` 폴더는 그 이름으로, 그 밖의 절대 경로(드라이브 `X:\…`·UNC `\\…`·`\\?\…`·`/home/…`·`/Users/…` 류 — 예: `uploads` 가 정션일 때의 대상 폴더)는 `<경로>` 로 바뀐다.
- `POST /backups/:id/restore {confirm:true}` (불러오기; `confirm` 이 `true` 가 아니면 400 `confirm_required`) → 200 `{ ok: true, restored: item, safety: item, keptSession: boolean, warnings: string[] }`. **어느 단계에서 실패하든 서버의 현재 데이터는 바뀌지 않은 채 오류를 낸다 — 마지막 DB 교체만 한 트랜잭션이다.** 순서:
  1. 게이트 → 뮤텍스(409 `busy`) → 사용자(없으면 IP)당 분당 3회(429 `rate_limited`) → id 검증(400)·폴더 확인(404).
  2. **점검 모드** `app.maintenance = true`(`finally` 로 반드시 해제): 이 동안 `handleApi` 는 GET/HEAD 가 아닌 모든 `/api` 요청에 **503 `busy`**("지금 저장본을 불러오는 중이에요. 잠시 뒤에 다시 해 주세요.", `Retry-After: 3`)를 준다 — 인증·권한·Origin 판정보다 앞이다. 읽기(GET/HEAD)·SSE 는 계속된다 — 단 **쓰는 GET 인 `/api/auth/google/*`(콜백이 사용자·세션을 만든다)도 503 이다.** `authenticate()` 는 이 동안 만료된 세션 행을 지우지 않는다(읽기만). `/api/backups*` 는 점검 모드의 대상이 아니라 뮤텍스(409)를 거친다. 업로드 정리·만료 세션 청소 타이머도 이 동안 쉰다.
  3. 백업의 `edulet.db` 를 OS 임시 폴더로 복사해 검사한다(미리보기와 같은 검사; 스키마가 더 낮으면 **임시 사본에** `openDb` 로 마이그레이션해 최신으로 올린다). 실패 → 422 `backup_invalid`.
  4. 업로드 파일 준비: 임시 사본의 `uploads` 행이 가리키는 파일(id 가 32자리 hex 인 것만)을 백업의 `uploads/` 에서 `data/uploads/` 로 복사. **이미 있는 파일은 건드리지 않는다**(같은 크기면 건너뜀, 크기가 다르면 건드리지 않고 `warnings`; 새 파일은 `.<id>.part` 로 복사해 이름을 바꾸며, 옛 실행이 남긴 `.part` 는 먼저 지운다). 백업 쪽이 링크·일반 파일 아님이면 건너뛰고 `warnings`, 백업에 파일이 없으면(옛 백업이 불완전) 건너뛰고 `warnings` — 불러오기를 막지는 않는다. 새로 복사한 파일은 기억해 두었다가 이후 단계가 실패하면 지운다.
  5. **복원 직전 안전 저장**: `tc0 = SELECT total_changes()`·`dv0 = PRAGMA data_version` → `backupData({ kind: 'before-restore' })`. 실패하면 중단(500 `backup_failed`, 데이터 불변, 새로 복사한 업로드 정리). 끝난 뒤 `total_changes()` 가 `tc0` 와 다르거나(이 연결의 쓰기) `data_version` 이 `dv0` 와 다르면(**다른 연결·다른 프로세스의 커밋** — `total_changes` 는 못 본다)(그 사이 무언가 DB 에 썼다 — 안전 저장이 최신이 아니다) 한 번 더(최대 3번), 그래도 다르면 중단 409 `data_changed`("그동안 다른 변경이 있어 중단했어요. 다시 해 주세요."). 점검 모드 덕에 거의 안 일어나며, **이 검사가 데이터 손실을 막는 마지막 방어선**이다 — 검사와 교체 사이에는 `await` 가 없다. 버려진 시도의 안전 저장 폴더는 이번 실행이 만든 것만 지운다.
  6. **교체(동기, 한 번에)**: 살아 있는 연결 `app.db.raw` 에서 `PRAGMA foreign_keys = OFF` → 임시 사본 `ATTACH` → `BEGIN IMMEDIATE`(쓰기 잠금을 잡은 직후 `data_version` 을 한 번 더 비교한다 — 마지막 검사와 잠금 사이에 다른 프로세스가 커밋했다면 409 `data_changed`, 롤백) → 현재 `sessions`(와 그 사용자 정보)를 읽어 둠 → 메인의 **모든 사용자 표**(`sqlite_master` 에서 읽음, `sqlite_%` 제외; 임시 사본에 같은 표·열이 없으면 오류로 롤백)를 자식→부모 순으로 `DELETE`, 부모→자식 순으로 열 이름을 명시해 `INSERT … SELECT` → `sqlite_sequence` 는 표별로 `max(현재, 백업)`(id 가 뒤로 가지 않게; `CAST(… AS INTEGER)` 로 정수로 쓴다) → 세션 정책 → `PRAGMA foreign_key_check` 가 비어 있지 않으면 롤백 → `COMMIT` → `DETACH` → **`finally` 에서 항상 `PRAGMA foreign_keys = ON`**. 오류면 `ROLLBACK`. 다른 모듈이 `app.db` 래퍼와 그 안의 준비된 문장을 붙잡고 있으므로 **연결을 닫고 다시 열지 않는다**.
  7. 교체 뒤: `app.hub.resetAll()`(§6 `reset`), 점검 모드 해제, 임시 폴더 삭제. 응답은 이 요청의 클라이언트에게 간다(쿠키는 건드리지 않는다).
- **세션 정책**: 백업의 `sessions` 는 **버린다**(오래된 토큰을 되살리지 않는다). 교체 직전의 살아 있는(만료 전) 세션 중, 교체 뒤 사용자 표에 **같은 사람**(`id`·`created_at`·`is_guest`·`IFNULL(username,'')`·`IFNULL(google_sub,'')` 가 모두 같음)이 있는 것만 다시 넣는다. 나머지(다른 PC 의 백업이라 id 가 다른 경우, 백업 뒤에 생긴 게스트 …)는 로그아웃되어 백업에 있던 계정으로 다시 로그인한다. `keptSession` = 이 요청의 세션이 살아남았는가.
- **업로드 정리와의 상호작용**: 교체 뒤 백업에 없는 현재 파일(백업 뒤에 올라온 것)은 24시간이 지나면 고아로 정리될 수 있다(§1 운영 참고) — 복원 직전 안전 저장에 들어 있으므로 괜찮다.
- 시험 전용 `createApp` 옵션 `backupHooks`(`afterValidate({ copy })`·`afterStage()`·`afterSafetySave(n)` — 불러오기가 각 단계 사이에 `await` 하는 함수들; 환경변수·HTTP 로는 못 바꾼다)는 중간 단계에서 실패·쓰기·동시 요청을 만들어 보는 길이다.

### 상태 코드
200/201 성공 · 400 `bad_request`/세부코드(`confirm_required`) · 401 `unauthorized` · 403 `forbidden`(+ `backup_local_only`, `member_required`) · 404 `not_found`(+ `backup_not_found`) · 408 `request_timeout` · 409(`username_taken`, `already_member`, `already_owner`, `owner_cannot_leave`, `board_full`, `busy`, `data_changed`) · 413 `too_large` · 422 `backup_invalid` · 429(`rate_limited`, `busy`, `quota_exceeded`, `too_many_connections` — §11) · 500 `server_error`(내부 메시지 노출 금지; `backup_failed`, `restore_failed` 는 한국어 이유가 있는 백업·불러오기 실패) · 503 `busy`(불러오는 동안의 점검 모드, `Retry-After: 3`). 알 수 없는 `/api` 경로는 404 JSON. `/api` 밖 GET 은 파일(`public/`)을 서빙하고, 파일이 없고 확장자가 없는 경로는 `index.html`(SPA).

## 6. 실시간 (SSE)

`GET /api/boards/:slug/events` — `text/event-stream`, 보드를 볼 수 있어야 연결(로그인 안 한 link 접속자도 가능). 열린 연결이 로그인 사용자당 10개(`SSE_PER_USER`)·접속 주소당 300개(`SSE_PER_IP`; 학교·교실이 공용 IP 하나를 쓰는 경우를 고려한 값)를 넘으면 429 `too_many_connections`(JSON, 스트림 아님; 연결이 끊기면 자리가 돌아온다). 25초마다 `: ping` 주석과 `ping` 명명 이벤트(브라우저 EventSource 는 주석을 못 보므로 침묵 감시용; 클라이언트는 70초 동안 아무 이벤트도 없으면 재연결) — 이때 연결의 **세션이 아직 유효한지**(삭제·만료)도 확인해 무효면 연결을 닫는다. 연결 직후 `hello` 이벤트. 이벤트 형식 `event: <type>\ndata: <JSON>\n\n`. 쓰기 요청이 `X-Client-Id` 헤더(클라이언트가 만든 랜덤 문자열)를 보내면 이벤트의 `origin` 에 그대로 실어 준다(자기 에코 무시용).

| type | data |
|---|---|
| `hello` | `{ presence:[PresenceUser], more }` (`PresenceUser = {id, displayName, avatarColor}`, 사용자 id 로 중복 제거, **접속 순서로 앞 50명만**; `more` = 목록에 없는 접속자 수, 보통 0) |
| `presence` | `{ presence:[PresenceUser], more }` (접속·이탈 시 전체 목록 — 같은 보드에서 **초당 1번 넘게 보내지 않는다**: 첫 변화는 바로, 그 뒤 변화는 모아서 한 번에, 마지막 상태를 담는다) |
| `board.updated` | `{ board, origin }` |
| `board.deleted` | `{ origin }` |
| `members.updated` | `{ origin }` — 받은 쪽은 `GET /boards/:slug` 로 자기 역할 재조회 |
| `section.created` / `section.updated` / `section.moved` | `{ section, origin }` (moved 는 새 rank 반영된 section) |
| `section.deleted` | `{ id, mode:'delete'|'move', origin }` — `move` 면 영향받은 게시물이 `post.updated` 로도 따로 온다 |
| `post.created` / `post.updated` / `post.moved` | `{ post, origin }` (`post` 에는 `reactions.*.mine` 이 **없다** — 클라이언트가 자기 `mine` 을 유지하며 병합) |
| `post.deleted` | `{ id, origin }` |
| `comment.created` | `{ postId, comment, commentCount, origin }` |
| `comment.deleted` | `{ postId, id, commentCount, origin }` |
| `reaction.updated` | `{ postId, reactions (counts only, mine 없음), by: userId, origin }` |
| `reset` | `{}` — 서버가 저장본을 **불러와** 데이터가 통째로 바뀌었다(§5 "저장하기·불러오기"). 모든 보드의 모든 연결에 이 프레임을 보낸 직후 서버가 연결을 닫는다(ping 타이머는 그대로). 클라이언트는 화면을 새로고침한다(같은 id 의 보드가 다른 내용일 수 있다) |

**이벤트는 연결마다 가공된다**: `post.*`·`comment.created` 의 `author` 와 `board.updated` 의 `board.owner` 에서 `username` 은 admin 연결과 본인에게만 남고(나머지는 `null`), `showAuthor=false` 보드에서 moderate 미만 연결은 남의 `author` 를 익명 객체(§4)로 받는다(본인 것은 그대로). 승인 보드에서 moderate 미만이 내용을 고쳐 게시물이 다시 pending 이 되면 moderate 이상·작성자 연결은 `post.updated`(`status:'pending'`), 그 밖의 연결은 `post.deleted` 를 받는다. 비밀번호 변경·로그아웃·세션 만료로 세션이 무효가 되면 그 세션의 연결은 서버가 닫는다.
pending 게시물 관련 이벤트는 moderate 이상과 작성자 연결에만 보낸다. 승인되면 다른 연결에는 `post.created` 로 보낸다. 보드를 볼 권한이 사라진 연결(비공개 전환·구성원 삭제)은 `board.updated`/`members.updated` 뒤 서버가 연결을 닫는다(클라이언트가 재조회해 403/404 를 처리).
서버는 `Last-Event-ID` 를 지원하지 않는다. 클라이언트는 재연결 시 **스냅샷을 다시 받는다**.

## 7. 시드 (`seed/*.json`, `server/seed.js`)

`SEED=auto` 이고 보드가 하나도 없으면 `seed/` 의 모든 JSON 을 읽어 만든다. 시드 소유자는 **로그인 불가 계정**(`password_hash=NULL`, `username=NULL`) 이므로 공개 서버에서 탈취될 수 없다. 형식:
```json
{ "owner": {"displayName":"…", "avatarColor":"#…"},
  "board": { "slug":"demo-board", "title":"…", "format":"rows", "wallpaper":"green", "visibility":"link", "linkAccess":"comment", "settings":{…} },
  "sections": [ {"key":"s1","title":"…"} ],
  "posts": [ { "section":"s1", "title":"…", "body":"…", "image":"img/xxx.jpg", "attachment":{…}, "color":null,
               "comments":[ {"body":"…"} ], "reactions": {"like":3} } ],
  "commenters": ["…"] }
```
`image` 는 `seed/` 기준 경로 — 시드 시 `DATA_DIR/uploads` 로 복사해 업로드 레코드를 만들고 `{kind:'image'}` 첨부로 만든다. 시드는 멱등(같은 slug 가 있으면 건너뜀). `node server/seed-cli.js [--reset-demo]`.
`seed/*.json` 이 쓸 수 있는 확장 필드(모두 구현할 것). 저장소에는 `practice.json` 하나만 들어 있고, 이미지·파일을 가리키는 필드는 시험이 임시 시드 폴더로 확인한다:
- `board.ageDays`: 보드 생성 시각 = 지금 − ageDays일. 게시물은 그 시각 + (목록 순서 × 60초). 댓글은 게시물 시각 + 1시간.
- `attachment.kind:'link'` 일 때 `preview.imageFile`(seed 기준 경로) → 업로드로 복사하고 `preview.image` 를 그 URL 로 채운다. 시드는 **네트워크를 쓰지 않는다**(미리보기를 JSON 값 그대로 저장).
- `attachment.kind:'file'`: `file`(seed 기준 경로, 업로드로 복사), `name`, `mime`; `previewImageFile` 이 있으면 업로드로 복사하고 첨부 `preview.image` 에 그 URL 을 넣는다(파일 카드 위에 미리보기 썸네일을 보여 주기 위함). `Post.attachment` 의 `file` 종류는 `preview?:{image}` 를 가질 수 있다.
- `board.slug`, `board.settings.newPostPosition`('bottom' 이면 목록 순서대로 rank 증가), 섹션은 `sections` 배열 순서대로 rank.
- `comments[].author` 가 없으면 소유자. 게시물 `color` 는 POST_COLORS 중 하나 또는 null. 파일 이름의 한글·공백은 URL 에서 퍼센트 인코딩해 `/uploads/<id>/<encoded-name>` 로 만든다.

## 8. 프런트 구조와 인터페이스

### 파일 소유
- **공용 기반(고정, 먼저 존재)**: `public/js/lib/{h,api,store,router,ui,constants,board-controller,markdown}.js`, `public/css/base.css`
- **F1 — 앱 셸·페이지**: `public/index.html`, `public/css/app.css`, `public/js/main.js`, `public/js/views/*` (home, auth 모달, dashboard, board-page 셸, 공유·설정·구성원 패널, 프로필)
- **F2 — 보드 캔버스**: `public/css/board.css`, `public/js/board/*` (레이아웃 7종, 게시물 카드, 작성기, 상세, 슬라이드쇼, 댓글, 반응)
- 서로의 파일을 수정하지 않는다. 기반 파일에 필요한 변경이 있으면 오케스트레이터에게 보고한다.

### F1 ↔ F2 접점
`public/js/views/board-page.js` (F1) 가 `BoardController`(기반)를 만들어 SSE 를 연결하고, 로드가 끝나면 F2 의 진입점을 부른다:
```js
// public/js/board/index.js  (F2 가 export)
export function mountBoard(rootEl, ctl)   // ctl: BoardController. 반환: { destroy() }
// 반환된 destroy 를 F1 이 라우트 이탈 시 호출. mountBoard 는 ctl.subscribe 로 상태를 구독해 스스로 다시 그린다.
```
F2 는 `rootEl` 안(배경 위 본문 영역 전체: 섹션/카드/작성기/상세/슬라이드쇼 오버레이 포함)만 책임진다. 상단바(로고·검색·슬라이드쇼·공유·설정·접속자)와 보드 제목 헤더는 F1 이 그리되, 다음은 `ctl` 로 소통한다:
- 검색어: `ctl.setSearch(q)` / `ctl.state.search` — F2 는 이를 반영해 카드를 거른다(제목·본문·작성자·첨부 이름에 포함).
- 슬라이드쇼 시작: `ctl.openSlideshow()` → `ctl.state.slideshow = true` → F2 가 오버레이를 연다/닫는다. 닫을 때 `ctl.closeSlideshow()`.
- 상세 보기: `ctl.openPost(id)` / `ctl.closePost()` → `ctl.state.openPostId` (URL 은 `/b/:slug/p/:id` 와 동기화: `ctl` 이 `router.replace` 를 호출한다).

### `BoardController` (기반 파일, 시그니처 고정)
```js
class BoardController {
  constructor(slug)
  state = { status: 'loading'|'ready'|'forbidden'|'notfound'|'error', board, role, isOwner, sections:[], posts:[], members:[],
            presence:[], me: User|null, search:'', openPostId: null, slideshow: false, connected: boolean }
  load()                 // 스냅샷 받고 SSE 연결. 재연결 시 자동 재조회
  destroy()              // SSE 닫기
  subscribe(fn) → unsubscribe   // 상태가 바뀔 때마다 fn({type, ...}) (type: 'snapshot'|'board'|'sections'|'posts'|'post'|'comments'|'presence'|'ui')
  can(action)            // 'view'|'post'|'comment'|'react'|'moderate'|'admin'|'owner'
  canEditPost(post) / canMovePost(post)   // 본인/역할 규칙
  // 파생
  get sectioned()        // board.format ∈ SECTIONED
  visiblePosts()         // 검색 적용, pending 규칙 적용(권한자·본인만)
  postsOf(sectionId)     // 정렬 규칙 적용(pinned DESC, rank ASC; backchannel 은 createdAt ASC)
  sortedSections()
  postById(id), indexOfPost(id) (visiblePosts 기준; 상세·슬라이드쇼 이전/다음용)
  // 액션 (모두 Promise, 실패 시 ApiError throw — 호출부가 toast 로 표시)
  createPost(data) updatePost(id, patch) deletePost(id) movePost(id,{sectionId,beforeId}) approvePost(id)
  setPostPosition(id,{x,y,w})   // 캔버스 드래그, 낙관적 반영
  react(id, kind, value)        // 낙관적 반영 후 응답으로 확정
  loadComments(id) → [Comment]  addComment(id, body) deleteComment(commentId, postId)
  createSection(title, beforeId?) renameSection(id,title) moveSection(id,beforeId) deleteSection(id, mode)
  upload(file, onProgress?) → attachment 입력({kind, uploadId, name, url, mime, size})
  linkPreview(url) → preview
  updateBoard(patch)            // 설정/형식/배경 …
  openPost(id) closePost() openSlideshow() closeSlideshow() setSearch(q)
}
```
낙관적 갱신은 이동·캔버스 위치·반응에만. 나머지는 서버 응답(또는 SSE 에코)으로 반영하며 `post.id` 로 멱등 병합한다. `origin` 이 내 clientId 면 SSE 에코는 무시하지 않고 **멱등 병합**(이미 있으면 덮어쓰기)한다 — 응답이 먼저 오든 이벤트가 먼저 오든 같은 결과여야 한다.

### 기반 모듈 요약
- `h(tag, props, ...children)` — `props`: `class`, `style`(객체), `on*` 이벤트, `dataset`, 그 외 속성. 문자열 자식은 텍스트 노드. `null/false` 무시, 배열 평탄화. `svg` 용 `h.svg`.
- `api` — `api.get/post/put/patch/del(path, body)`; 실패 시 `ApiError{status, code, message}`; `X-Client-Id` 자동; `api.upload(slug, file, onProgress)`; 401 이면 `store` 의 `me` 를 비운다.
- `store` — 작은 반응형 저장소: `store.me`, `store.config`, `store.subscribe(key, fn)`, `store.set(key, v)`. `store.loadMe()`.
- `router` — History API: `route('/b/:slug', handler)`, `router.go(path)`, `router.replace(path)`, `router.start()`; 링크 클릭 가로채기(`a[data-link]`). 핸들러는 `(params, query) => cleanupFn|void` 를 반환.
- `ui` — `modal({title, body, actions, onClose, size})`, `toast(msg, kind)`, `confirmDialog({title, message, danger})`, `popover(anchorEl, items)`(⋮ 메뉴), `avatar(user, size)`, `timeAgo(ms)`, `icon(name)`(인라인 SVG 아이콘 세트), `copyText(text)`, `qr(text)`(없으면 null).
- `markdown.js` — `renderRich(text) → DocumentFragment`: 안전한 부분 집합만 (문단·줄바꿈, `**굵게**`, `*기울임*`, `` `코드` ``, `- ` 목록, 자동 링크(`http(s)` 만, `rel="noopener noreferrer" target="_blank"`)). HTML 은 전부 텍스트로 취급.

## 9. 시각 명세 (보드 앱의 일반적인 구성을 관찰 + 자체 디자인)

- 전체: 배경(wallpaper) 위에 콘텐츠. 상단 얇은 바(좌: 앱 로고 텍스트 `Edulet`, 우: 검색·슬라이드쇼·공유·설정(⚙)·접속자 아바타·사용자 메뉴). 그 아래 보드 헤더: `작성자 • 시간` 작은 글씨, 큰 제목(굵게), 설명.
- 배경 프리셋은 CSS 그라데이션(자체 제작). `green` 이 기본(연두→초록 방사형 그라데이션)이다. `night` 등 어두운 배경에는 헤더 글씨를 흰색, 밝은 배경은 어두운 글씨.
- 게시물 카드: 흰색(또는 post color 의 연한 틴트), 둥근 모서리 12px, 약한 그림자. 머리줄(원형 아바타·작성자·`n분 전`·⋮ 메뉴), 굵은 제목, 첨부 미리보기(이미지는 카드 폭 가득·비율 유지, 링크는 썸네일+도메인+제목, 파일은 아이콘+이름+크기, 영상은 썸네일+재생 아이콘), 본문, 하단(좌: 반응 버튼, 우: 💬 댓글 수). 카드 폭 ≈ 256px(rows/shelf), wall 은 최소 240px 벽돌식 다단, grid 는 균등 격자, stream 은 중앙 단일 열(최대 680px), canvas 는 절대 위치.
- `rows`/`shelf` 섹션 머리: 어두운 초록 탭 모양(둥근 위쪽 모서리)에 굵은 글씨 + `⋯` 버튼(이름 변경·삭제·왼/오른쪽 이동·카드 추가). `rows` 는 줄마다 가로 스크롤, `shelf` 는 열마다 세로 스크롤, 섹션 끝에 `+` 카드 추가 버튼. 섹션 추가 버튼은 맨 끝.
- 작성기: 보드 우하단 둥근 `+` 플로팅 버튼(write 권한자만) 또는 섹션의 `+`. 누르면 카드 자리에 인라인 작성기(제목, 본문, 첨부 도구줄: 이미지/파일/링크/색상) — 모바일에서는 하단 시트. 붙여넣기·드래그앤드롭으로 이미지 첨부. 게스트가 쓰려면 이름 입력(게스트 로그인) 먼저.
- 상세 보기: 전체 화면 오버레이, 왼쪽 큰 미디어(없으면 본문 크게), 오른쪽 360px 패널(작성자·제목·본문·반응 줄·댓글 목록·댓글 입력창), 좌상단 ✕, 우측 상단 `n / N` 과 ‹ › 버튼, 키보드 ←→/Esc.
- 슬라이드쇼: 전체 화면, 카드 한 장씩 크게, ←→ 이동, Space 자동 재생(5초) 토글, Esc 종료, 진행 `n / N`.
- 접근성: 모든 버튼에 `aria-label`, 포커스 링, 모달 포커스 트랩·Esc, 색 대비 4.5:1, `prefers-reduced-motion` 존중. 모바일(≤ 640px) 단일 열 대응, 터치 드래그.
- 한국어 문구는 존댓말 아닌 간결한 안내체(예: "보드를 만들었어요", "저장하지 못했어요. 다시 시도해 주세요").

## 10. 수용 기준 (오케스트레이터가 직접 검증)

1. `npm start` 한 줄로 기동, 시드된 연습장이 `/b/practice` 에 `wall` 형식으로 카드 3장과 함께 뜬다.
2. 두 브라우저(서로 다른 사용자)가 같은 보드를 열고, 한쪽의 게시물·댓글·반응·이동·섹션 변경이 **새로고침 없이** 다른 쪽에 나타난다.
3. 7개 형식 모두 렌더되고 형식 전환이 즉시 반영된다. 드래그로 순서 변경·섹션 간 이동(rows/shelf)·캔버스 이동이 저장된다.
4. 권한표가 서버에서 강제된다(프런트 숨김에만 의존하지 않음). 비로그인 read 접속자는 쓰기 UI 가 없고, API 로 쓰면 401/403.
5. 이미지·파일 업로드, 링크 미리보기, YouTube 임베드, 내보내기(JSON/CSV), 복제, 공유 링크/QR 이 동작한다.
6. `npm test` 통과(서버 단위·통합). XSS 시험 문자열(`<img onerror>`, `javascript:` 링크)이 어디서도 실행되지 않는다.

## 11. 남용 방지·한도 (서버가 강제, 프런트는 오류 코드만 사람 말로 보여 준다)

모든 한도 오류는 `{ error:{ code, message(한국어) } }` 이고 429 에는 `Retry-After`(초)가 붙는다. 기본값은 §1 표의 환경변수로 바꾼다.

| 대상 | 한도(기본) | 오류 |
|---|---|---|
| 업로드 동시 수 | 서버 6 · 사용자 2 | 429 `busy` — 본문을 읽기 전에 거절 |
| 업로드 요청 | 사용자당 10분 30회(실패한 것도 센다) | 429 `rate_limited` |
| 업로드 용량 | 사용자당 24시간 300MB(선언된 `Content-Length` 로 먼저, 다 받은 뒤 다시 판정) | 429 `quota_exceeded` |
| 업로드 본문 정지 | 30초 무응답 | 408 `request_timeout` |
| JSON 본문 | 1MB, 20초 안에 도착해야 함 | 413 `too_large` / 408 `request_timeout` |
| 쓰기(게시물·댓글·반응·섹션의 생성·수정·이동·삭제·승인) | 사용자당 분당 240 | 429 `rate_limited` |
| 보드의 게시물 수 | 5000(pending 포함) | 409 `board_full` |
| 로그인 실패 | 사용자명당 15분 10회 | 429 `rate_limited` (§5 인증) |
| 비밀번호 변경 | IP 당 분당 20회(인증 한도 공유) + 계정별 15분 10회 틀림 | 429 `rate_limited` |
| 프로필 수정(`PATCH /auth/me`) | 사용자당 분당 30 | 429 `rate_limited` |
| Google 로그인(`/auth/google/start`·`/callback`) | IP 당 분당 `GOOGLE_RATE`(300), 두 경로 합산 + 서버 전체 토큰 교환 분당 1200 | JSON 이 아니라 돌아갈 주소로 302 + 플래시 `google_rate` (§5) |
| Google 연결·해제(`POST /auth/google/link`·`/unlink`) | 비밀번호 변경과 같음: IP 당 인증 분당 20회(공유) + 계정별 15분 10회 틀림(공유) | 429 `rate_limited` / 401 `bad_credentials` |
| 구성원 추가(사용자명 조회) | 사용자당 분당 30 | 429 `rate_limited` |
| 링크 미리보기 | 사용자당 분당 20 · 호스트당 분당 60 · 동시 8 (§5) | 429 `rate_limited`(사용자) / 최소 미리보기(그 밖) |
| 실시간 연결 | 사용자당 10 · 주소당 60 · 서버 2000 소켓 | 429 `too_many_connections` |
| 접속자 목록 | 앞 50명 + `more` · 보드당 초당 1번 | — |
| 서버의 내부(LAN) 주소 | `GET /config` 의 `share.lan` 은 **이 PC 에서 localhost 로 연 요청**에만 채운다(§5 네 조건, 프록시 헤더가 있으면 안 채움). 그 밖의 요청은 `[]` | — (빈 목록) |

인증·가입·게스트: IP 당 분당 20회(429 `rate_limited`)는 그대로다.

## 12. 정적 데모 모드 (GitHub Pages — `tools/build-pages.mjs`)

Pages 는 파일만 내려 주므로 Node 서버를 못 쓴다. 이 빌드에서는 **서비스 워커(`public/edulet-sw.js` + `public/demo/sw-*.js`)가 §5 REST 와 §6 이벤트의 서버 역할**을 하고, 프런트는 서버 모드와 **같은 코드**다(차이는 아래 둘뿐). 데이터는 방문자 브라우저의 IndexedDB 에만 있다 — 다른 기기·사람과 공유되지 않는다.

- **하위 경로**: 앱은 `BASE`(`public/js/lib/base.js` — 서버 모드 `""`, Pages `"/edulet"`)를 모든 내부 URL(`/api`·`/uploads`·`/seed`·`/assets`·라우터 링크)에 붙인다. `demo/boot.js` 가 `window.EDULET_BASE`·`EDULET_DEMO` 를 앱보다 먼저 정하고 서비스 워커가 페이지를 제어할 때까지 `window.__edulet_ready` 로 부팅을 미룬다.
- **달라지는 것**: 쿠키 대신 요청 헤더 `X-Edulet-Session`(localStorage `edulet_demo_sid`) · 보드 SSE 는 `EventSource` 대체물이 `POST /api/_demo/stream`(등록)·`/stream/ping`·`/stream/close` 로 워커에 연결을 알리고, 이벤트는 BroadcastChannel `edulet-demo-events` 로 같은 브라우저의 탭들에 전달(§6 이벤트 형식 그대로) · 비밀번호 PBKDF2-SHA256(WebCrypto 에 scrypt 없음) · 업로드 한도 10MB(Blob 으로 IndexedDB 에 저장, 서빙 헤더는 §11 하드닝 그대로) · 링크 미리보기는 브라우저에서 닿는 주소만(oEmbed best-effort) · 내보내기 링크는 헤더가 필요해 `api.download()` 로 받는다.
- **Google 로그인은 없다**: 클라이언트 시크릿을 둘 서버가 없고, 데이터가 이 브라우저 안에만 있어 "다른 기기에서 같은 계정" 이라는 Google 로그인의 쓸모도 없다. 워커의 `GET /config` 는 `google:false` 라서 프런트가 버튼을 숨긴다. `/auth/*` 사용자 JSON 의 `hasPassword`(비게스트 `true`)·`googleEmail`(`null`)은 서버 모드와 같은 모양으로 낸다.
- **공유 주소가 없다**: 데이터가 방문자 브라우저 안에만 있어 다른 기기에서 여는 주소가 존재하지 않는다. 워커의 `GET /config` 는 `share: { origin: null, lan: [] }` 와 `demo: true` 를 내고, 공유 창은 "이 데모는 이 브라우저 안에서만 동작해요 — 함께 쓰려면 서버 모드" 안내를 보여 준다.
- **저장하기·불러오기는 없다**: 이 데모에는 서버 PC 도 `backups/` 폴더도 없다. 워커의 `GET /config` 는 `backup: { available: false }` 를 내고 화면은 메뉴를 숨긴다.
- **없는 것**: §11 의 요청·업로드 한도와 SSRF 검사(자기 브라우저 안에서만 도는 데모라 대상이 아님). 한도 테스트(`test/`)는 서버 모드 전용이다.
- **데모 전용 경로**: `/api/_demo/*`(스트림 등록, `reset` = 시드 복원). 초기화는 같은 브라우저의 모든 탭을 다시 불러온다.
- **검증**: `npm run e2e:pages` (`e2e/pages.mjs`) — `/edulet/` 아래 정적 서버(없는 경로는 `404.html`, Pages 와 같음)로 빌드를 띄워 부팅·딥링크·두 탭 실시간·보드 생성·7형식·업로드·내보내기·로그아웃/로그인·초기화·워커 재시작 복구·바깥 요청 없음을 본다.
