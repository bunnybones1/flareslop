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

The script logs the `iceServers` array it receives to confirm your credentials are being surfaced to the client.
