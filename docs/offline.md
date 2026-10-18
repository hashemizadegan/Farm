# Working without signal

Metafarm installs on a phone ("Add to Home screen" / "Install app") and keeps working in the field
when the connection drops.

## What works offline

| | |
|---|---|
| Pages opened recently on the phone | Shown from the phone's copy (service worker, `apps/web/public/sw.js`). |
| Data seen recently (tasks, farms, stock…) | The last API response for each read is kept and shown offline. |
| Completing a task (note, inputs used; photos already uploaded) | Kept on the phone and sent when back online. |
| Recording an observation | Same. |
| Recording a harvest | Same. The label code and fingerprint are issued when it reaches the server. |
| Anything else (planning, stock deliveries, settings, uploads) | Needs a connection. |

A bar at the top of the app says when you are offline, how many records are waiting, and lists any
the server refused (for example a task cancelled by a manager in the meantime) so they can be
discarded.

## How resends stay safe

Every queued write carries an `Idempotency-Key` (a UUID made on the phone). If the phone sends a
record, loses the reply and sends it again, the API returns the original result instead of
recording twice (`raw_observations.client_request_id`, `harvest_batches.client_request_id`,
`farm_tasks.completion_request_id`, migration `0010`). A key reused by someone else, or for another
farm, is refused (409).

Queued records belong to the person who made them: only they see them, and they are sent with their
own sign-in. If the sign-in has expired, they wait until the person signs in again.

## Privacy on shared phones

- The sign-in is kept on the device (localStorage) until the access token expires, so a reopened
  app works offline.
- The offline copy of API responses is deleted on sign-out. Someone who shares a phone should sign
  out at the end of the day.
