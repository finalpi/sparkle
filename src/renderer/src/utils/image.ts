interface Canvas2D {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

export interface ImageRgbColor {
  red: number
  green: number
  blue: number
}

export type ImageColorPreset =
  | 'original'
  | 'grayscale'
  | 'monochrome'
  | 'invert'
  | 'vivid'
  | 'warm'
  | 'cool'
  | 'sepia'
  | 'highContrast'
  | 'soft'

interface SquareCropArea {
  x: number
  y: number
  size: number
}

interface CropImageOptions {
  maxOutputSize?: number
  cornerRadiusPercent?: number
  colorPreset?: ImageColorPreset
  rgbColor?: ImageRgbColor
}

export function createCanvas2D(width: number, height: number): Canvas2D | undefined {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))

  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined

  return { canvas, ctx }
}

export function canvasToPngDataURL(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

export async function loadImageElement(dataURL: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = dataURL
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
  })

  return image
}

export async function cropAndPadTransparent(
  base64: string,
  finalSize = 256,
  border = 24
): Promise<string> {
  const img = await loadImageElement(base64)
  const source = createCanvas2D(img.width, img.height)
  if (!source) return base64

  const { canvas, ctx } = source
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)

  const { data, width, height } = imgData
  let top = height,
    bottom = 0,
    left = width,
    right = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4 + 3
      if (data[i] > 10) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }

  if (right < left || bottom < top) return base64

  const cropWidth = right - left + 1
  const cropHeight = bottom - top + 1
  const contentSize = finalSize - 2 * border

  const aspectRatio = cropWidth / cropHeight
  let drawWidth = contentSize
  let drawHeight = contentSize
  let offsetX = border
  let offsetY = border

  if (aspectRatio > 1) {
    drawHeight = contentSize / aspectRatio
    offsetY = border + (contentSize - drawHeight) / 2
  } else {
    drawWidth = contentSize * aspectRatio
    offsetX = border + (contentSize - drawWidth) / 2
  }

  const output = createCanvas2D(finalSize, finalSize)
  if (!output) return base64

  const { canvas: outCanvas, ctx: outCtx } = output
  outCtx.clearRect(0, 0, finalSize, finalSize)
  outCtx.drawImage(
    canvas,
    left,
    top,
    cropWidth,
    cropHeight,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight
  )

  return canvasToPngDataURL(outCanvas)
}

function getLuminance(red: number, green: number, blue: number): number {
  return red * 0.299 + green * 0.587 + blue * 0.114
}

function clampByte(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 255)
}

function applyContrast(value: number, amount: number): number {
  return (value - 128) * amount + 128
}

function applyImageColorPreset(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  colorPreset: ImageColorPreset
): void {
  if (colorPreset === 'original') return

  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData

  for (let i = 0; i < data.length; i += 4) {
    const red = data[i]
    const green = data[i + 1]
    const blue = data[i + 2]

    if (colorPreset === 'invert') {
      data[i] = 255 - red
      data[i + 1] = 255 - green
      data[i + 2] = 255 - blue
      continue
    }

    const luminance = getLuminance(red, green, blue)
    if (colorPreset === 'vivid') {
      data[i] = clampByte((red - luminance) * 1.45 + (red - 128) * 1.12 + 128)
      data[i + 1] = clampByte((green - luminance) * 1.45 + (green - 128) * 1.12 + 128)
      data[i + 2] = clampByte((blue - luminance) * 1.45 + (blue - 128) * 1.12 + 128)
      continue
    }

    if (colorPreset === 'warm') {
      data[i] = clampByte(red * 1.12 + 10)
      data[i + 1] = clampByte(green * 1.04 + 4)
      data[i + 2] = clampByte(blue * 0.9)
      continue
    }

    if (colorPreset === 'cool') {
      data[i] = clampByte(red * 0.88)
      data[i + 1] = clampByte(green * 1.02 + 2)
      data[i + 2] = clampByte(blue * 1.14 + 8)
      continue
    }

    if (colorPreset === 'sepia') {
      data[i] = clampByte(red * 0.393 + green * 0.769 + blue * 0.189)
      data[i + 1] = clampByte(red * 0.349 + green * 0.686 + blue * 0.168)
      data[i + 2] = clampByte(red * 0.272 + green * 0.534 + blue * 0.131)
      continue
    }

    if (colorPreset === 'highContrast') {
      data[i] = clampByte(applyContrast(red, 1.42))
      data[i + 1] = clampByte(applyContrast(green, 1.42))
      data[i + 2] = clampByte(applyContrast(blue, 1.42))
      continue
    }

    if (colorPreset === 'soft') {
      data[i] = clampByte(red * 0.88 + 24)
      data[i + 1] = clampByte(green * 0.88 + 24)
      data[i + 2] = clampByte(blue * 0.88 + 24)
      continue
    }

    const value = colorPreset === 'monochrome' ? (luminance >= 128 ? 255 : 0) : luminance
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
  }

  ctx.putImageData(imageData, 0, 0)
}

function applyImageRgbColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rgbColor: ImageRgbColor
): void {
  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData
  const redColor = clampByte(rgbColor.red)
  const greenColor = clampByte(rgbColor.green)
  const blueColor = clampByte(rgbColor.blue)

  for (let i = 0; i < data.length; i += 4) {
    data[i] = (data[i] * redColor) / 255
    data[i + 1] = (data[i + 1] * greenColor) / 255
    data[i + 2] = (data[i + 2] * blueColor) / 255
  }

  ctx.putImageData(imageData, 0, 0)
}

function applyRoundedMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number
): void {
  if (radius <= 0) return

  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.beginPath()
  ctx.roundRect(0, 0, width, height, Math.min(radius, width / 2, height / 2))
  ctx.fill()
  ctx.restore()
}

export function cropImageElementToPngDataURL(
  image: HTMLImageElement,
  crop: SquareCropArea,
  options: CropImageOptions | number = {}
): string | undefined {
  const {
    maxOutputSize = 1024,
    cornerRadiusPercent = 0,
    colorPreset = 'original',
    rgbColor
  } = typeof options === 'number' ? { maxOutputSize: options } : options
  const outputSize = Math.max(1, Math.min(maxOutputSize, Math.round(crop.size)))
  const output = createCanvas2D(outputSize, outputSize)
  if (!output) return undefined

  const { canvas, ctx } = output
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, outputSize, outputSize)
  if (rgbColor) {
    applyImageRgbColor(ctx, outputSize, outputSize, rgbColor)
  } else {
    applyImageColorPreset(ctx, outputSize, outputSize, colorPreset)
  }
  applyRoundedMask(ctx, outputSize, outputSize, (outputSize * cornerRadiusPercent) / 100)

  return canvasToPngDataURL(canvas)
}
