#!/bin/bash

# Update test files to import internal APIs from _internal.ts
for file in tests/*.ts src/cli.ts; do
  if [ -f "$file" ]; then
    # Check if file has both index import AND internal APIs
    if grep -q "from.*'../src/index" "$file" && grep -qE "createApiKeyService|createFeltDbRuntime|FeltDb" "$file"; then
      echo "Updating $file..."
      
      # For lines that import createApiKeyService or FeltDb stuff from index, change to _internal
      sed -i "s|from '\.\./src/index\.js'|from '../src/_internal.js'|g" "$file"
      sed -i "s|from '\./index\.js'|from './_internal.js'|g" "$file"
    fi
  fi
done
