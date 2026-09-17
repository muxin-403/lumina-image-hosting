'use strict';

/**
 * 生成各类测试图片（用于本地验证上传/优化/缩略图链路）
 * 用法：node examples/make-test-assets.js [输出目录]
 * 产出：sample.png / sample.jpg / anim.gif / vector.svg / big.jpg
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tmp-assets'));
fs.mkdirSync(outDir, { recursive: true });

/**
 * 用 sharp 的 join 能力合成一个 2 帧动画 GIF，
 * 用于验证「动态图不丢帧」的处理链路。
 */
async function buildAnimatedGif(size = 120) {
  const frame = (rgb) =>
    sharp({
      create: { width: size, height: size, channels: 4, background: { ...rgb, alpha: 1 } },
    })
      .png()
      .toBuffer();

  const frames = [
    await frame({ r: 79, g: 140, b: 255 }),
    await frame({ r: 240, g: 120, b: 60 }),
    await frame({ r: 34, g: 193, b: 164 }),
  ];

  return sharp(frames, { join: { animated: true } })
    .gif({ delay: 300, loop: 0 })
    .toBuffer();
}

async function main() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">
  <!-- 注释：Lumina 测试矢量图 -->
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#22c1a4"/>
  </linearGradient></defs>
  <rect width="240" height="120" rx="16" fill="url(#g)"/>
  <circle cx="60" cy="60" r="30" fill="#ffffff" fill-opacity="0.85"/>
  <text x="120" y="68" font-family="sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">Lumina</text>
</svg>`;

  const tasks = [
    ['sample.png', await sharp({ create: { width: 800, height: 500, channels: 4, background: { r: 79, g: 140, b: 255, alpha: 1 } } }).png().toBuffer()],
    ['sample.jpg', await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 240, g: 120, b: 60 } } }).jpeg({ quality: 95 }).toBuffer()],
    ['sample.webp', await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 34, g: 193, b: 164, alpha: 1 } } }).webp().toBuffer()],
    ['sample.avif', await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 120, g: 80, b: 200 } } }).avif({ quality: 60 }).toBuffer()],
    ['anim.gif', await buildAnimatedGif(120)],
    ['vector.svg', Buffer.from(svg, 'utf8')],
    ['big.jpg', await sharp({
      create: { width: 6000, height: 4000, channels: 3, background: { r: 18, g: 24, b: 40 } },
    }).jpeg({ quality: 96 }).toBuffer()],
  ];

  for (const [name, buf] of tasks) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, buf);
    console.log(`生成 ${name.padEnd(14)} ${(buf.length / 1024).toFixed(1)} KB`);
  }
  console.log(`\n输出目录：${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
