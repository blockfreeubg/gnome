# Catalog test fixtures

Unmodified responses captured on **2026-11-10** (one polite request each, user agent
`GNOME-catalog/0.1 (+self-hosted; fixture capture)`, ≥ 1.5 s apart). They replace the research samples listed in
`docs/research/games-sources.md` §10, whose scratch directory no longer exists. Header files are the response
headers of the same requests (CRLF line endings normalized to LF).

| File | Request |
| --- | --- |
| `gamepix-p1.json` | `GET https://feeds.gamepix.com/v2/json?sid=1&pagination=12&page=1` |
| `gamepix-chess-p1.json` … `-p3.json` | `GET https://feeds.gamepix.com/v2/json?sid=1&pagination=12&page={1,2,3}&category=chess` (29 games; page 3 has no `next_url`) |
| `gamepix-mahjong-p1.json` | `GET https://feeds.gamepix.com/v2/json?sid=1&pagination=96&page=1&category=mahjong` (29 games, single page) |
| `gamepix-pubdate.json` | `GET https://feeds.gamepix.com/v2/json?sid=1&pagination=12&page=1&order=pubdate` |
| `gamepix-badsid.json` | `GET https://feeds.gamepix.com/v2/json?sid=TEST123&pagination=12&page=1` → HTTP 400 |
| `gamedistribution-p1.json` | `GET https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=all&categories=All&tags=All&subType=all&type=all&mobile=all&rewarded=all&amount=10&page=1&format=json` |
| `gamedistribution-p1.headers` | its headers (weak ETag `W/"3790-uh5RA/LCmaLPy5IOyTIc1a5Dv9I"`) |
| `gamedistribution-p1-304.headers` | the same request with `If-None-Match` set to that ETag → `304 Not Modified` |
| `gamedistribution-end.json` | same feed, `amount=100&page=100000` → `[]` |
| `playgama-p1.json` | `POST https://widgets.playgama.com/api/v1/partner/export/catalogue/games` body `{"pagination":{"limit":10,"offset":0},"sort":{"type":"ranking_default"},"filters":{"ageGroups":[],"interests":[],"platforms":[],"supportedLanguages":[],"hasInAppPurchases":false}}` → 201 |
| `gamemonetize-p1.json` | `GET https://gamemonetize.com/feed.php?format=0&num=10&page=1` |
| `famobi.json` | `GET https://api.famobi.com/feed?n=10` |
| `itch-free-web.xml` | `GET https://itch.io/games/free/platform-web.xml` (36 items) |
| `js13k-2012.xml`, `js13k-2026.xml` | `GET https://js13kgames.com/{2012,2026}/games.xml` (62 and 317 items) |
| `dedup-temple-blocks.json` | One real cross-source duplicate: the `temple-blocks` item of `GET https://api.famobi.com/feed` and item `64CPP1` of the GamePix v2 feed (`sid=1`, 96 per page), both from 2026-11-10, copied verbatim into one file (87 such title overlaps exist between the two full catalogs) |

Some integration tests build feed pages from a *subset* of the records in these files (for example the first nine
GameDistribution items) to simulate a game disappearing from a feed; the records themselves are never altered.
