import { LINE_MEDIA_LIMITS, type ImagemapWidth } from '@line-crm/shared'

type LoadedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('画像を読み込めませんでした'))
    image.src = objectUrl
  })
  return {
    source: image,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    close: () => URL.revokeObjectURL(objectUrl),
  }
}

/** Read intrinsic pixel dimensions without retaining the decoded bitmap. */
export async function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  const image = await loadImage(file)
  try {
    return { width: image.width, height: image.height }
  } finally {
    image.close()
  }
}

/** Detect the PNG animation-control chunk without decoding or rendering the image. */
export async function isAnimatedPng(file: Blob): Promise<boolean> {
  if (file.type !== 'image/png') return false
  const bytes = new Uint8Array(await file.arrayBuffer())
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value)) return false

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) return false
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'acTL') return true
    // The APNG control chunk must precede the first image-data chunk.
    if (type === 'IDAT' || type === 'IEND') return false
    offset = chunkEnd
  }
  return false
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました')),
      type,
      quality,
    )
  })
}

async function drawResized(
  image: LoadedImage,
  width: number,
  mimeType: 'image/jpeg' | 'image/png',
  quality = 0.88,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(image.height * canvas.width / image.width))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('このブラウザでは画像を変換できません')
  if (mimeType === 'image/jpeg' && 'fillRect' in context) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  context.drawImage(image.source, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas, mimeType, mimeType === 'image/jpeg' ? quality : undefined)
}

/** LINE image-message preview (JPEG/PNG, <= 1 MiB) をブラウザ内で作る。 */
export async function createLinePreview(file: File): Promise<Blob> {
  if (file.size <= LINE_MEDIA_LIMITS.previewImageBytes) return file

  const image = await loadImage(file)
  try {
    let width = image.width
    let quality = 0.88
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const blob = await drawResized(image, width, 'image/jpeg', quality)
      if (blob.size <= LINE_MEDIA_LIMITS.previewImageBytes) return blob
      width = Math.max(1, Math.floor(width * 0.82))
      quality = Math.max(0.5, quality - 0.06)
    }
  } finally {
    image.close()
  }
  throw new Error('プレビュー画像を1MB以下に縮小できませんでした')
}

/** LINE imagemap が要求する 5 段階の幅を、1040px の原稿から生成する。 */
export async function createImagemapVariants(file: File): Promise<Array<{ width: ImagemapWidth; height: number; blob: Blob }>> {
  const image = await loadImage(file)
  try {
    if (image.width !== 1040) throw new Error('画像の横幅は1040pxにしてください')
    const variants: Array<{ width: ImagemapWidth; height: number; blob: Blob }> = []
    for (const width of LINE_MEDIA_LIMITS.imagemapWidths) {
      let blob = await drawResized(image, width, file.type === 'image/png' ? 'image/png' : 'image/jpeg')
      // A very complex PNG can exceed the LINE ceiling even at 1040px. JPEG is the
      // interoperable fallback, while keeping the required dimensions unchanged.
      if (blob.size > LINE_MEDIA_LIMITS.imagemapImageBytes) {
        blob = await drawResized(image, width, 'image/jpeg', 0.82)
      }
      if (blob.size > LINE_MEDIA_LIMITS.imagemapImageBytes) {
        throw new Error(`${width}px画像を10MB以下に変換できませんでした`)
      }
      variants.push({ width, height: Math.max(1, Math.round(image.height * width / image.width)), blob })
    }
    return variants
  } finally {
    image.close()
  }
}
