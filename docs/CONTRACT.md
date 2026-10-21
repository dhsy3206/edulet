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
               realtime.js(SSE) seed.js seed-cli.js constants.js
public/        index.html  css/{base,app,board}.css  js/main.js  js/lib/*  js/views/*  js/board/*  assets/
seed/          *.json (시드 보드), img/ (시드 이미지)
test/          *.test.js (node:test)
docs/          CONTRACT.md REFERENCE.md screens/
data/          (gitignore) edulet.db, uploads/
```

설정(환경변수, `server/config.js`): `PORT`(3000) `HOST`(0.0.0.0) `DATA_DIR`(./data) `SESSION_DAYS`(30) `MAX_UPLOAD_MB`(20) `ALLOW_REGISTER`(1) `SEED`(auto|0|1, auto = DB 가 비었을 때만) `TRUST_PROXY`(0) `LINK_PREVIEW`(1) `COOKIE_SECURE`(auto: TRUST_PROXY 이고 X-Forwarded-Proto=https 이면 Secure). 모두 접두사 `EDULET_`.
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

`createApp({ dataDir, port, seed })` 를 export 해서 테스트가 임시 폴더·임의 포트로 서버를 띄우고 `{ url, server, close() }` 를 받는다. `npm start` 는 이것을 호출한다. http 서버는 `headersTimeout` 20초, `requestTimeout` 10분을 명시한다.

### 운영 참고
- **HTTPS 뒤에 둘 때**: 세션 쿠키는 `COOKIE_SECURE=auto` 에서 `TRUST_PROXY=1` 이고 프록시가 `X-Forwarded-Proto: https` 를 보낼 때만 `Secure` 가 붙는다. TLS 를 프록시가 끝내는 배포는 `EDULET_TRUST_PROXY=1` (프록시가 `X-Forwarded-For`·`X-Forwarded-Proto` 를 **덮어쓰도록** 설정) 또는 `EDULET_COOKIE_SECURE=1` 을 명시한다. 프록시 뒤에서 `TRUST_PROXY` 를 켜지 않으면 모든 사용자가 한 IP 로 보여 IP 단위 한도(인증 분당 20회, 실시간 연결 60개)를 함께 쓴다. 반대로 서버를 직접 공개하면서 `TRUST_PROXY=1` 을 켜면 `X-Forwarded-For` 를 클라이언트가 속일 수 있으니 켜지 않는다.
- **`linkAccess` 와 구성원 역할**: 실효 역할은 소유자 → 구성원 행(그 역할 그대로) → `linkAccess`(§4) 순이다. 구성원 행은 링크 역할을 **문자 그대로 덮어쓰므로** `read` 구성원이 있는 보드가 `linkAccess=write` 이면, 그 사람이 로그아웃하고 새 게스트로 들어오면 `write` 를 얻는다(막으려면 `linkAccess` 를 낮추거나 `visibility=private`). 서버는 이를 막지 않는다.
- **게스트와 사용자 단위 한도**: 업로드 용량·쓰기·링크 미리보기·실시간 연결 한도는 *사용자*(게스트 포함) 단위다. 게스트 계정은 새로 만들 수 있으므로(IP 당 분당 20회) 이 한도들은 IP 단위 인증 한도·서버 전체 상한(동시 업로드 6, 동시 미리보기 8, 소켓 2000)과 함께 작동한다. 누구나 쓸 수 있는 `linkAccess=write` 보드를 공개 서버에 둘 때는 디스크 여유를 감시한다.
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
      avatar_color TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)
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
**`username`(로그인 이름)은 본인과 그 보드의 admin 에게만 실제 값**이고, 그 밖의 보는 사람에게는 `null` 이다(게시물·댓글의 `author`, 보드의 `owner`, 내보내기, SSE 이벤트 모두). `/auth/*` 응답은 항상 본인이므로 그대로 온다. admin 의 구성원 목록(`GET /boards/:slug/members`, 스냅샷의 `members`, 구성원 추가·수정 응답)은 전원의 `username` 을 담는다. 클라이언트는 `username` 이 `null` 이면 "@아이디" 표시를 생략한다(게스트와 구별할 필요가 있으면 `isGuest` 를 쓴다).

### 인증
- `GET  /config` → `{ allowRegister, maxUploadMb, linkPreview, version }`
- `GET  /health` → `{ ok:true }`
- `GET  /auth/me` → `{ user: User|null }`
- `POST /auth/register {username,password,displayName}` → `{ user }` (+쿠키). 중복 409 `username_taken`
- `POST /auth/login {username,password}` → `{ user }`. 실패 401 `bad_credentials` (사용자 없음/비번 틀림 구분 금지, 해시 비교 시간 균일화). **계정별 실패 제한**: 같은 사용자명(소문자로 정규화, 계정이 있든 없든)으로 15분 안에 `LOGIN_FAIL_MAX`(10)번 실패하면 그 이름은 잠긴다 — 잠긴 동안은 올바른 비밀번호여도 비밀번호를 확인하지 않고 429 `rate_limited`(+`Retry-After`)를 준다. 존재하지 않는 이름도 똑같이 잠기므로 응답으로 계정 존재를 알 수 없다. 로그인에 성공하면 그 이름의 실패 횟수가 지워진다. (남이 일부러 실패를 쌓아 계정을 15분간 잠글 수 있다는 점은 이 설계의 알려진 대가다.)
- `POST /auth/guest {displayName}` → `{ user }` (+쿠키, 게스트 계정 생성). 이미 로그인 상태면 표시 이름만 갱신
- `POST /auth/logout` → `{ ok:true }`
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

### 상태 코드
200/201 성공 · 400 `bad_request`/세부코드 · 401 `unauthorized` · 403 `forbidden` · 404 `not_found` · 408 `request_timeout` · 409(`username_taken`, `already_member`, `already_owner`, `owner_cannot_leave`, `board_full`) · 413 `too_large` · 429(`rate_limited`, `busy`, `quota_exceeded`, `too_many_connections` — §11) · 500 `server_error`(내부 메시지 노출 금지). 알 수 없는 `/api` 경로는 404 JSON. `/api` 밖 GET 은 파일(`public/`)을 서빙하고, 파일이 없고 확장자가 없는 경로는 `index.html`(SPA).

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
실제 `seed/*.json` 이 쓰는 확장 필드(모두 구현할 것):
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

## 9. 시각 명세 (참조 보드 관찰 + 자체 디자인)

- 전체: 배경(wallpaper) 위에 콘텐츠. 상단 얇은 바(좌: 앱 로고 텍스트 `Edulet`, 우: 검색·슬라이드쇼·공유·설정(⚙)·접속자 아바타·사용자 메뉴). 그 아래 보드 헤더: `작성자 • 시간` 작은 글씨, 큰 제목(굵게), 설명.
- 배경 프리셋은 CSS 그라데이션(자체 제작). `green` 이 기본이며 참조 보드의 인상(연두→초록 방사형 그라데이션)을 따른다. `night` 등 어두운 배경에는 헤더 글씨를 흰색, 밝은 배경은 어두운 글씨.
- 게시물 카드: 흰색(또는 post color 의 연한 틴트), 둥근 모서리 12px, 약한 그림자. 머리줄(원형 아바타·작성자·`n분 전`·⋮ 메뉴), 굵은 제목, 첨부 미리보기(이미지는 카드 폭 가득·비율 유지, 링크는 썸네일+도메인+제목, 파일은 아이콘+이름+크기, 영상은 썸네일+재생 아이콘), 본문, 하단(좌: 반응 버튼, 우: 💬 댓글 수). 카드 폭 ≈ 256px(rows/shelf), wall 은 최소 240px 벽돌식 다단, grid 는 균등 격자, stream 은 중앙 단일 열(최대 680px), canvas 는 절대 위치.
- `rows`/`shelf` 섹션 머리: 어두운 초록 탭 모양(둥근 위쪽 모서리)에 굵은 글씨 + `⋯` 버튼(이름 변경·삭제·왼/오른쪽 이동·카드 추가). `rows` 는 줄마다 가로 스크롤, `shelf` 는 열마다 세로 스크롤, 섹션 끝에 `+` 카드 추가 버튼. 섹션 추가 버튼은 맨 끝.
- 작성기: 보드 우하단 둥근 `+` 플로팅 버튼(write 권한자만) 또는 섹션의 `+`. 누르면 카드 자리에 인라인 작성기(제목, 본문, 첨부 도구줄: 이미지/파일/링크/색상) — 모바일에서는 하단 시트. 붙여넣기·드래그앤드롭으로 이미지 첨부. 게스트가 쓰려면 이름 입력(게스트 로그인) 먼저.
- 상세 보기(참조 보드와 동일한 구성): 전체 화면 오버레이, 왼쪽 큰 미디어(없으면 본문 크게), 오른쪽 360px 패널(작성자·제목·본문·반응 줄·댓글 목록·댓글 입력창), 좌상단 ✕, 우측 상단 `n / N` 과 ‹ › 버튼, 키보드 ←→/Esc.
- 슬라이드쇼: 전체 화면, 카드 한 장씩 크게, ←→ 이동, Space 자동 재생(5초) 토글, Esc 종료, 진행 `n / N`.
- 접근성: 모든 버튼에 `aria-label`, 포커스 링, 모달 포커스 트랩·Esc, 색 대비 4.5:1, `prefers-reduced-motion` 존중. 모바일(≤ 640px) 단일 열 대응, 터치 드래그.
- 한국어 문구는 존댓말 아닌 간결한 안내체(예: "보드를 만들었어요", "저장하지 못했어요. 다시 시도해 주세요").

## 10. 수용 기준 (오케스트레이터가 직접 검증)

1. `npm start` 한 줄로 기동, 시드된 참조 보드가 `/b/demo-board` 에 `rows` 형식으로 17개 카드·섹션 3개·댓글 2개와 함께 뜬다.
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
| 구성원 추가(사용자명 조회) | 사용자당 분당 30 | 429 `rate_limited` |
| 링크 미리보기 | 사용자당 분당 20 · 호스트당 분당 60 · 동시 8 (§5) | 429 `rate_limited`(사용자) / 최소 미리보기(그 밖) |
| 실시간 연결 | 사용자당 10 · 주소당 60 · 서버 2000 소켓 | 429 `too_many_connections` |
| 접속자 목록 | 앞 50명 + `more` · 보드당 초당 1번 | — |

인증·가입·게스트: IP 당 분당 20회(429 `rate_limited`)는 그대로다.
