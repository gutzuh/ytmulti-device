# ytmulti-device

Multi-device YouTube Music controller — play, sync, and jam across browser, mobile, desktop, and TV, just like Spotify Connect but built for YouTube Music.

## Features

- **Multi-device control** — register any browser, mobile, desktop, or TV device; see all active devices in real time.
- **Transfer playback** — move audio from one device to another with a single click.
- **Jam sessions** — create a jam, share a 6-character code, and every participant's device syncs playback in real time.
- **Playback controls** — play/pause, previous/next, seek bar, and volume slider all work across devices.
- **Real-time updates** — powered by WebSockets so every connected device sees the current state instantly.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (default port 3000)
npm start

# Open http://localhost:3000 in as many browser tabs or devices as you like
```

## Development

```bash
# Auto-restart on file changes (Node 18+)
npm run dev

# Run tests
npm test
```

## WebSocket Protocol

After connecting to the WebSocket endpoint (`ws://host:port`) clients exchange JSON messages.

### Client → Server

| `type`          | Required fields                  | Description                             |
|-----------------|----------------------------------|-----------------------------------------|
| `register`      | `deviceName`, `deviceType`       | Register device (`browser`/`mobile`/`desktop`/`tv`/`other`) |
| `heartbeat`     | —                                | Keep-alive ping (every 20 s)            |
| `transfer_to`   | `deviceId`                       | Transfer active playback to a device    |
| `control`       | `action`, `value?`               | `play`/`pause`/`next`/`prev`/`seek`/`volume` |
| `update_track`  | `track`                          | Active device reports current track info |
| `create_jam`    | `jamName?`                       | Create a new jam session                |
| `join_jam`      | `jamCode`                        | Join an existing jam by 6-char code     |
| `leave_jam`     | —                                | Leave the current jam                   |
| `jam_control`   | `action`, `value?`               | Host-only: `play`/`pause`/`seek` all participants |

### Server → Client

| `type`           | Key fields                        | Description                             |
|------------------|-----------------------------------|-----------------------------------------|
| `registered`     | `deviceId`, `playback`            | Registration confirmed                  |
| `heartbeat_ack`  | —                                 | Heartbeat acknowledged                  |
| `devices`        | `devices[]`                       | Current device list (broadcast)         |
| `playback_state` | `state`                           | Current playback state (broadcast)      |
| `become_active`  | `playback`                        | This device is now the active player    |
| `control`        | `action`, `value?`                | Forwarded control command               |
| `jam_created`    | `jamCode`, `jam`                  | Jam session created                     |
| `jam_joined`     | `jam`                             | Successfully joined a jam               |
| `jam_left`       | —                                 | Left the jam                            |
| `jam_state`      | `jam`                             | Jam state update (broadcast to members) |
| `error`          | `message`                         | Error response                          |

## REST API

| Method | Path              | Description               |
|--------|-------------------|---------------------------|
| GET    | `/api/devices`    | List connected devices    |
| GET    | `/api/playback`   | Current playback state    |
| GET    | `/api/jams`       | List active jam sessions  |
| GET    | `/api/jams/:code` | Get jam session by code   |

## Architecture

```
+-----------------------------------------------------+
|                   Express + ws Server               |
|                                                     |
|  +------------+  +--------------+  +-------------+  |
|  |  REST API  |  |  WebSocket   |  |  Session    |  |
|  | /api/*     |  |  Handler     |  |  Manager    |  |
|  +------------+  +------+-------+  +------+------+  |
|                         |                 |          |
|              register / control / jam     |          |
|                         +-----------------+          |
+-----------------------------------------------------+
        |                    |                   |
   Browser tab          Mobile device        Desktop app
```
