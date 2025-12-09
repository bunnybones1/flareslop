# ICE Server Configuration

The Worker exposes ICE servers to clients as part of the `/join` response. By default we supply public STUN fallbacks, but you should provision a TURN provider and configure credentials via secrets before shipping.

## Default Behaviour

- When no custom configuration is set, the Worker returns:
  ```json
  [
    {
      "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
    }
  ]
  ```
- Clients receive this list in the `iceServers` field of the join response and can pass it directly to `RTCPeerConnection`.

## Custom TURN / STUN Servers

1. Prepare a JSON array of `RTCIceServer` entries, for example:
   ```json
   [
     {
       "urls": ["stun:stun.cloudflare.com:3478"]
     },
     {
       "urls": ["turn:turn.your-provider.com:3478"],
       "username": "turn-user",
       "credential": "turn-password"
     }
   ]
   ```
2. Store it as an encrypted Worker secret:
   ```sh
   cd workers/voice-chat
   wrangler secret put ICE_SERVERS_JSON
   # paste the JSON from step 1
   ```
3. (Optional) Repeat for your preview environment with provider demo credentials.

The Worker validates that each entry contains `urls` and filters out malformed objects before returning the list.

## Testing

After setting the secret, restart `wrangler dev` and run the Phase 1 local test:

```sh
pnpm run voice:test:phase1
```

## Cloudflare Managed TURN (recommended)

If you have a Cloudflare TURN server, the Worker can request short-lived credentials on every `/join`:

1. Create a TURN server and note your **TURN Token ID** and **API Token**.
2. Configure the Worker:
   ```sh
   wrangler secret put TURN_API_TOKEN        # paste your API Token
   wrangler secret put TURN_TOKEN_ID         # paste the TURN Token ID
   # Optional overrides:
   # wrangler secret put TURN_API_URL        # defaults to https://rtc.live.cloudflare.com/v1/turn/credentials
   # wrangler secret put TURN_CACHE_TTL_SECONDS  # cache duration in seconds (default ~60s)
   ```
3. Restart `wrangler dev` and run the Phase 1 test.

On each join, the Worker will:
- Call the Cloudflare TURN credentials endpoint with your token pair.
- Validate the returned `iceServers` and cache them briefly based on the TTL from the response (or the override).
- Fall back to `ICE_SERVERS_JSON` (or the built-in STUN defaults) if the TURN request fails.

The script logs the `iceServers` array it receives to confirm your credentials are being surfaced to the client.
