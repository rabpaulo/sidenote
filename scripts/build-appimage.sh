#!/usr/bin/env bash
set -e

# Script de automação para construção do AppImage do InterviewAI
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "================================================"
echo "🚀 Iniciando build do AppImage (Linux x64)"
echo "================================================"

# 1. Checa dependências
if ! command -v node &> /dev/null; then
  echo "❌ Node.js não foi encontrado. Por favor instale o Node.js."
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ npm não foi encontrado. Por favor instale o npm."
  exit 1
fi

# 2. Garante que build/icon.png existe
if [ ! -f "build/icon.png" ]; then
  echo "🎨 Gerando ícone build/icon.png a partir de public/favicon.svg..."
  mkdir -p build/icons
  if command -v rsvg-convert &> /dev/null; then
    rsvg-convert -w 512 -h 512 public/favicon.svg -o build/icon.png
    cp build/icon.png build/icons/512x512.png
  elif command -v magick &> /dev/null; then
    magick -background none -density 512 public/favicon.svg -resize 512x512 build/icon.png
    cp build/icon.png build/icons/512x512.png
  fi
fi

# 3. Compilação do Frontend (Vite)
echo "📦 1/2 Compilando frontend (Vite)..."
npm run build

# 4. Empacotamento do Electron e geração do AppImage
echo "📦 2/2 Gerando AppImage com electron-builder..."
npx electron-builder --linux appimage

echo ""
echo "================================================"
echo "✅ AppImage criado com sucesso!"
echo "Localização:"
ls -lh release/*.AppImage
echo "================================================"
echo "Para executar o AppImage diretamente:"
echo "  chmod +x release/*.AppImage"
echo "  ./release/*.AppImage"
echo "================================================"
