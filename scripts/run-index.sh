#!/bin/bash
# OSM incremental index — auto-resumes from checkpoints; run on boot/wake.
cd /home/patrickpassos/agent-memory
export PATH="$(mise where node@22)/bin:$PATH"
set -a; source /home/patrickpassos/.config/agent-secrets/.env; set +a
OPENAI_API_KEY=$(python3 -c "
import os
keys=[]; seen=set()
for k,v in os.environ.items():
    if k.startswith('VOYAGE_API_KEY') and len(v.strip())>30:
        v=v.strip()
        if v not in seen: seen.add(v); keys.append(v)
print(','.join(keys))")
export OPENAI_API_KEY
export VAULT_PATH="/home/patrickpassos/obsidian-vault" EMBEDDING_PROVIDER=openai
export EMBEDDING_BASE_URL="https://api.voyageai.com/v1" EMBEDDING_MODEL="voyage-4-large" EMBEDDING_DIMS=1024
exec node dist/cli.js index
