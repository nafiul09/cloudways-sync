// SVG markup for the CloudwaysSync nav-rail icon.
//
// Uses the Cloudways brand glyph (stacked horizontal bars with a
// cloud silhouette) but rendered as a monochrome silhouette: the
// original brand blue `#2f39bf` is swapped for `currentColor` so
// Local's existing sidebar link CSS tints it — grayish-white when
// idle, greenish-white on hover and `.__Active`, identical to how
// Local's own Sites / Connect / Blueprints icons behave.
//
// Kept at the 24x24 box size the rest of Local's rail uses; the
// original artwork's 512x512 viewBox is preserved so the path
// renders crisp at any DPR.
export const CLOUDWAYSSYNC_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 512 512"
     fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"
     stroke-linejoin="round" stroke-miterlimit="2" aria-hidden="true">
  <path d="M171.296 275.979H18.344C11.654 275.979 6 270.407 6 263.87c0-6.56 5.653-12.107 12.344-12.107h162.364c7.034-12.345 16.943-22.892 28.838-30.775H84.38c-6.666 0-12.336-5.572-12.336-12.108 0-6.544 5.67-12.107 12.336-12.107h152.495c3.815-11.241 9.55-21.625 16.813-30.775H108.07c-6.69 0-12.344-5.539-12.344-12.107 0-6.536 5.653-12.108 12.344-12.108h172.951c16.193-9.959 35.342-15.71 55.856-15.71 51.167 0 93.828 35.767 103.42 83.208 37.98 11.004 65.7 45.488 65.7 86.328 0 49.737-41.06 90.021-91.72 90.021h-.32v.294H94.396c-6.682 0-12.328-5.522-12.328-12.099 0-6.544 5.646-12.115 12.328-12.115h104.163c-9.411-8.546-17-19.003-22.115-30.75l-19.68.007c-3.996 0-7.01-2.957-7.01-6.887v-10.138c0-3.922 3.006-6.87 7.01-6.87h13.079a88.563 88.563 0 01-.735-11.463c0-6.74.751-13.316 2.19-19.631zm-60.235 54.99H21.988c-3.995 0-6.985-2.958-6.985-6.888v-10.138c0-3.922 2.99-6.87 6.985-6.87h88.747c3.995 0 7.01 2.948 7.01 6.87v10.138c.318 3.62-3.015 6.887-6.684 6.887z"/>
</svg>
`.trim();
