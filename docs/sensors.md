# Live sensors

Sensors send readings to the farm by themselves over HTTPS. Each sensor has its
own device token; only a SHA-256 of it is stored, and it is shown once, when the
sensor is registered or when a new token is issued.

## Registering

Farm → **Sensors** → *Register a sensor* (managers). Copy the token into the device
(or the gateway that forwards for it). *Issue a new token* replaces it; *Disable*
stops a device immediately.

## Sending readings

```http
POST /v1/ingest/readings
Authorization: Sensor mfs_<sensor id>_<secret>
Content-Type: application/json

{"readings":[{"metric":"soil_moisture","value":23.4,"unit":"percent_vwc","observedAt":"2026-10-18T06:00:00Z"}]}
```

- Up to 200 readings per request (a device can buffer through an outage and send them later).
- `metric`: `soil_moisture`, `air_temperature`, `soil_temperature`, `rainfall`, `relative_humidity`, `ndvi`.
- `unit`: any supported unit for that metric (e.g. `celsius`, `fahrenheit`, `kelvin`; `mm`, `cm`, `in`;
  `percent_vwc`, `fraction_vwc`). Readings are converted to the standard unit; unknown units are rejected, never guessed.
- `observedAt`: when the device measured, with a time-zone offset.
- Responses: `202 {"accepted": n}`; `400` for a malformed batch (nothing is stored); `401` for a missing,
  wrong, replaced or disabled token. Limit: 120 requests per minute per device address.

Readings are labelled `sensor-reported` and appear on the farm's Sensors and Observations pages.

## Alerts

- **Rules** (farm → Alerts → *Alert rules*): e.g. soil moisture below 15 % for 2 readings in a row within 60 minutes.
  Evaluated every few minutes by the scheduler.
- **Silent sensors**: a sensor that has reported before but sends nothing for longer than its allowance
  (default 3 hours) raises a warning alert, once per silence.

Gateways for LoRaWAN or other radio networks forward to the same endpoint; keep each physical sensor's
token on the gateway, not in firmware shared across devices.
