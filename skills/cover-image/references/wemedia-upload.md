# WeMedia Studio Image Upload via MCP

After generating a cover image, it needs a public URL to embed in X posts. MK hosts images on WeMedia Studio's upload endpoint.

## Normal Flow (MCP tools registered)

When Hermes Agent starts with the `wemedia-studio` MCP server connected, the tool `mcp_wemedia_studio_upload_image_from_base64` is available:

1. Read the generated image as bytes: `Path(...).read_bytes()`
2. Base64 encode: `base64.b64encode(data).decode()`
3. Call the MCP tool with `data` (base64 string), `mime_type` (e.g. `"image/png"`), and `filename_hint`
4. The response includes `hosted_url` like `http://localhost:8000/api/uploads/abc123.png`
5. Embed in post: `![alt](hosted_url)`

## Fallback Flow (MCP tools not registered)

If MCP tools aren't visible in your tool list, call the StreamableHTTP endpoint directly via Python httpx:

```python
import httpx
import base64
from pathlib import Path

async def upload_image(img_path: str, filename_hint: str = "cover.png"):
    img_data = Path(img_path).read_bytes()
    b64 = base64.b64encode(img_data).decode()
    
    async with httpx.AsyncClient() as client:
        # Step 1: Initialize session
        r1 = await client.post(
            "http://localhost:8000/mcp",
            json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "hermes", "version": "1.0"}
                }
            },
            headers={"Accept": "text/event-stream, application/json"}
        )
        session_id = r1.headers.get("mcp-session-id")
        
        # Step 2: Send initialized notification
        await client.post(
            "http://localhost:8000/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers={
                "Accept": "text/event-stream, application/json",
                "mcp-session-id": session_id
            }
        )
        
        # Step 3: Call the upload tool
        r3 = await client.post(
            "http://localhost:8000/mcp",
            json={
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {
                    "name": "upload_image_from_base64",
                    "arguments": {
                        "data": b64,
                        "mime_type": "image/png",
                        "filename_hint": filename_hint
                    }
                }
            },
            headers={
                "Accept": "text/event-stream, application/json",
                "mcp-session-id": session_id
            }
        )
        # Parse SSE response
        import json
        data_str = r3.text
        # Extract JSON from SSE event
        if "data: " in data_str:
            json_str = data_str.split("data: ", 1)[1].strip()
            result = json.loads(json_str)
            return result["result"]["content"][0]["text"]
    return None
```

## Session ID Management

The WeMedia Studio MCP uses StreamableHTTP transport. Session IDs are:
- Returned as HTTP header `mcp-session-id` in the initialize response
- Required on all subsequent requests as header `mcp-session-id`
- Ephemeral — each initialize call creates a new session

## Limitations

- Max upload size: 10 MB
- Allowed formats: JPEG, PNG, GIF, WebP, SVG, AVIF
- Base64 encoding adds ~33% overhead — for images >7.5 MB the base64 string will hit tool argument size limits. For very large images, use `upload_image_from_url` instead (upload to a temp host first, then let WeMedia Studio fetch it).
- The `image_generate` tool typically outputs 1-3 MB PNGs, which is well within limits.
