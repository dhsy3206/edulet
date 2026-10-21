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
`createApp({ dataDir, port, seed })` 를 export 해서 테스트가 임시 폴더·임의 포트로 서버를 띄우고 `{ url, close() }` 를 받는다. `npm start` 는 이것을 호출한다.

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
uploads(id TEXT PK /* 32 hex */, user_id → users, board_id NULL, name, mime, size, created_at)   -- 파일은 DATA_DIR/uploads/<id>
```
인덱스: posts(board_id, section_id, rank), comments(post_id), board_members(user_id), sessions(expires_at).
**순서(rank)**: REAL. 새 게시물/섹션은 `newPostPosition`에 따라 (섹션 내) 최소−1 / 최대+1. 이동은 이웃 두 rank 의 중간값, 간격 < 1e-6 이면 그 목록을 1..n 으로 재번호.
정렬 규칙: `pinned DESC, rank ASC` (캔버스·백채널 제외). 백채널은 `created_at ASC` 고정.

## 4. 권한

실효 역할 `role(board, user)`: 소유자 → `admin`(+owner) / `board_members` 행 → 그 역할 / 그 외 `visibility=link` 이면 `linkAccess` / 아니면 `null`(접근 불가, 404 로 응답해 존재를 숨긴다).

| 동작 | 필요 역할 |
|---|---|
| 보드 보기, 내보내기 | read |
| 댓글 쓰기, 반응 | comment (댓글 `settings.comments=off` 면 댓글 불가, 반응은 `settings.reactions≠none`) |
| 게시물 작성 | write (`approval=true` 이고 역할이 write 면 `status=pending`) |
| 게시물 수정·삭제 | **본인 글**은 write 이상, **남의 글**은 moderate 이상 |
| 게시물 이동·캔버스 위치 | 본인 글은 write 이상, 남의 글은 moderate 이상 |
| 핀 고정, 승인(pending→published), 남의 댓글 삭제 | moderate |
| 섹션 생성·수정·이동·삭제 | moderate |
| 보드 설정 변경, 구성원 관리 | admin |
| 보드 삭제, 소유권 | owner (이 버전은 삭제만) |

pending 게시물은 **moderate 이상과 작성자 본인에게만** 목록·이벤트로 보인다. 게스트(`is_guest=1`)는 일반 사용자와 같은 규칙이되 보드를 만들 수 없다(403 `guest_cannot_create`).
쓰기 요청의 **Origin 헤더가 있고 Host 와 다르면 403 `bad_origin`** (CSRF). 쓰기 본문은 `application/json` (업로드 제외).

## 5. REST API (모든 경로 `/api` 아래, JSON, 쿠키 `edulet_sid` HttpOnly·SameSite=Lax·Path=/)

사용자 JSON `User`: `{ id, username (게스트는 null), displayName, avatarColor, isGuest }`

### 인증
- `GET  /config` → `{ allowRegister, maxUploadMb, linkPreview, version }`
- `GET  /health` → `{ ok:true }`
- `GET  /auth/me` → `{ user: User|null }`
- `POST /auth/register {username,password,displayName}` → `{ user }` (+쿠키). 중복 409 `username_taken`
- `POST /auth/login {username,password}` → `{ user }`. 실패 401 `bad_credentials` (사용자 없음/비번 틀림 구분 금지, 해시 비교 시간 균일화)
- `POST /auth/guest {displayName}` → `{ user }` (+쿠키, 게스트 계정 생성). 이미 로그인 상태면 표시 이름만 갱신
- `POST /auth/logout` → `{ ok:true }`
- `PATCH /auth/me {displayName?, avatarColor?, currentPassword?, newPassword?}` → `{ user }`
- 비밀번호는 `crypto.scrypt`(솔트 16B, N=2^15 이상) 로 `scrypt$N$r$p$salt$hash` 저장. 세션 토큰 32B 랜덤, DB 에는 SHA-256 만 저장. 로그인·가입·게스트: IP 당 분당 20회 제한(429 `rate_limited`).

### 보드
`Board` JSON: `{ id, slug, title, description, format, wallpaper, font, colorScheme, visibility, linkAccess, settings, owner: User, createdAt, updatedAt }`
- `GET  /boards` → `{ boards: [ { ...Board, role, postCount, memberCount } ] }` (내가 소유·구성원인 것, `updatedAt DESC`) — 로그인 필수 401
- `POST /boards {title, description?, format?, template?}` → `{ board }` (소유자 admin). `template` 은 섹션(과 형식)을 미리 채운다:
  `blank`(wall, 섹션 없음) · `kwl`(shelf: 알고 있는 것 / 알고 싶은 것 / 배운 것) · `retro`(shelf: 잘한 점 / 아쉬운 점 / 시도할 점) · `training`(rows: 1부 / 2부). 명시한 `format` 이 우선.
- `GET  /boards/:slug` → 스냅샷
  `{ board, role, isOwner, sections:[Section], posts:[Post], members?:[Member] (admin 만), presence:[PresenceUser] }`
  접근 불가·없음 → 404 `not_found`. 로그인 안 한 사용자도 `visibility=link` 면 읽기 가능(`role` 은 linkAccess).
- `PATCH /boards/:slug {title?, description?, format?, wallpaper?, font?, colorScheme?, visibility?, linkAccess?, settings?}` → `{ board }` (admin, `settings` 는 병합). 형식을 `shelf/rows` 로 바꿀 때 섹션이 0개면 "섹션 1" 을 만들고 섹션 없는 게시물을 거기로 옮긴다(이 변경은 `section.created`·`post.moved` 이벤트로도 알린다).
- `DELETE /boards/:slug` (owner) → `{ ok:true }` (업로드 파일 정리 포함)
- `POST /boards/:slug/duplicate {withPosts?: boolean}` → `{ board }` (read 이상이면 누구나, 내가 소유자. 제목 "… 사본". 게시물 복사 시 작성자는 원 작성자 유지, 반응·댓글은 복사 안 함, 업로드 첨부는 같은 파일 URL 공유)
- `GET  /boards/:slug/members` / `POST /boards/:slug/members {username, role}` / `PATCH /boards/:slug/members/:userId {role}` / `DELETE /boards/:slug/members/:userId` (admin). `Member = { user: User, role }`. 소유자는 목록에 `role:"admin", isOwner:true` 로 항상 첫 줄. 구성원 변경 시 `members.updated` 이벤트.
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
- `POST /boards/:slug/posts {title?, body?, sectionId?, color?, attachment?, x?, y?, w?}` → `{ post }`. 제목·본문·첨부가 모두 비면 400 `empty_post`. `attachment` 입력: `{kind:'image'|'file', uploadId}`(업로드 결과) 또는 `{kind:'link'|'video', url}`(서버가 미리보기를 채움; 미리보기 실패해도 저장은 성공, `preview` 는 `{title:url}` 정도) 또는 `{kind:'image', url:'https://…'}`(외부 이미지 주소). `javascript:`·`data:` 등 http(s) 가 아닌 URL 은 400 `bad_url`.
- `PATCH /posts/:id {title?, body?, sectionId?, color?, pinned?, attachment?: object|null, x?, y?, w?}` → `{ post }`
- `DELETE /posts/:id` → `{ ok:true }`
- `POST /posts/:id/move {sectionId: number|null, beforeId: number|null}` → `{ post }` (같은 섹션 안 순서 변경 포함. `beforeId=null` = 그 섹션 맨 끝)
- `POST /posts/:id/approve` → `{ post }`
- `GET  /posts/:id/comments` → `{ comments:[Comment] }`, `Comment = { id, postId, author: User, body, createdAt }` (오래된 순)
- `POST /posts/:id/comments {body}` → `{ comment, commentCount }`
- `DELETE /comments/:id` → `{ commentCount }` (본인 또는 moderate)
- `PUT  /posts/:id/reactions {kind:'like'|'vote'|'star'|'grade'|'emoji', value?}` → `{ reactions }` (내 `mine` 포함). `like/vote/star` 토글. `grade` 는 `value` 1–10 설정, 같은 값을 다시 보내거나 0 이면 취소. `emoji` 는 `value` 가 EMOJIS 중 하나, 토글(여러 개 가능). 보드의 `settings.reactions` 와 `kind` 가 다르면 400 `reaction_disabled`.

### 업로드·링크
- `PUT  /uploads?board=<slug>&name=<파일이름>` — 본문은 **원시 바이트**, `Content-Type` 은 파일 MIME. write 이상. 한도 `MAX_UPLOAD_MB`(초과 413 `too_large`, 본문 읽다가 끊는다). 파일 이름은 정규화(경로 구분자 제거, 길이 ≤ 100). 이미지(png/jpeg/gif/webp)는 **앞부분 매직 바이트로 검증**하고 MIME 을 그 결과로 확정한다(SVG 거부). → `{ id, url:"/uploads/<id>/<name>", name, mime, size, kind:'image'|'file' }`
- `GET  /uploads/<id>/<name>` (경로가 `/api` 밖) — 인증 없이 제공(id 가 추측 불가능한 비밀 주소). 이미지는 inline, 그 외는 `Content-Disposition: attachment`. 항상 `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: public, max-age=31536000, immutable`. Range 요청 지원(영상·PDF).
- `POST /link-preview {url}` → `{ url, kind:'link'|'video', title, description, image, site, embedUrl? }` (로그인 필수, 분당 20회). 서버가 가져오는 쪽이라 **SSRF 방어 필수**: http(s) 만, 모든 DNS 결과를 검사해 루프백·사설·링크로컬·CGNAT·멀티캐스트·ULA·`169.254.169.254` 거부, 연결 시 검사한 주소로 고정(`lookup` 훅), 리다이렉트 최대 3회(매번 재검사), 타임아웃 5초, 본문 512KB 까지만, `text/html` 만 파싱(OG/Twitter/`<title>`/description). YouTube(`youtube.com/watch`, `youtu.be`, `shorts`) → `kind:'video'`, `embedUrl:https://www.youtube-nocookie.com/embed/<id>`, 썸네일 `https://i.ytimg.com/vi/<id>/hqdefault.jpg`. Vimeo 도 같은 방식(`player.vimeo.com/video/<id>`). `EDULET_LINK_PREVIEW=0` 이면 외부 요청 없이 호스트명만 돌려준다. 결과는 메모리에 10분 캐시.

### 상태 코드
200/201 성공 · 400 `bad_request`/세부코드 · 401 `unauthorized` · 403 `forbidden` · 404 `not_found` · 409 · 413 · 429 · 500 `server_error`(내부 메시지 노출 금지). 알 수 없는 `/api` 경로는 404 JSON. `/api` 밖 GET 은 파일(`public/`)을 서빙하고, 파일이 없고 확장자가 없는 경로는 `index.html`(SPA).

## 6. 실시간 (SSE)

`GET /api/boards/:slug/events` — `text/event-stream`, 보드를 볼 수 있어야 연결(로그인 안 한 link 접속자도 가능). 25초마다 `: ping` 주석. 연결 직후 `hello` 이벤트. 이벤트 형식 `event: <type>\ndata: <JSON>\n\n`. 쓰기 요청이 `X-Client-Id` 헤더(클라이언트가 만든 랜덤 문자열)를 보내면 이벤트의 `origin` 에 그대로 실어 준다(자기 에코 무시용).

| type | data |
|---|---|
| `hello` | `{ presence:[PresenceUser] }` (`PresenceUser = {id, displayName, avatarColor}`, 사용자 id 로 중복 제거) |
| `presence` | `{ presence:[PresenceUser] }` (접속·이탈 시 전체 목록) |
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
