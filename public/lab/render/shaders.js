// shaders.js - GLSL ES 3.00 sources for the Fragline lab renderer.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
`;

// Shared lighting: Doom-style diminishing light + soft dynamic point lights + light fog.
const LIGHT = `
uniform vec3 uCam;
uniform int uNL;
uniform vec4 uLP[16];   // xyz = position, w = radius
uniform vec4 uLC[16];   // rgb = colour * intensity
uniform float uAmbient;     // minimum brightness
uniform float uFogDensity;
uniform vec3 uFogColor;
uniform float uClassic;     // 1 = quantised light levels (classic Doom banding)
uniform float uLightGain;

float doomShade(float light, float depth) {
  float ln = clamp(light * (1.0 / 16.0), 0.0, 15.0);
  if (uClassic > 0.5) ln = floor(ln);
  float startmap = (15.0 - ln) * 4.0;
  float idx = clamp(startmap - 1280.0 / max(depth, 1.0), 0.0, 31.0);
  if (uClassic > 0.5) idx = floor(idx);
  return max(1.0 - idx * (1.0 / 32.0), uAmbient);
}

vec3 dynLight(vec3 p, vec3 n, int mask) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uNL) break;
    if (((mask >> i) & 1) == 0) continue;      // light can not reach this sector (walls/closed doors in between)
    vec3 d = uLP[i].xyz - p;
    float dist = length(d);
    float a = max(1.0 - dist / uLP[i].w, 0.0);
    a *= a;
    float ndl = 0.45 + 0.55 * abs(dot(n, d / max(dist, 0.001)));
    sum += uLC[i].rgb * (a * ndl);
  }
  return sum * uLightGain;
}

vec3 shadeColor(vec3 base, float light, float depth, vec3 p, vec3 n, int mask) {
  float sh = doomShade(light, depth);
  vec3 c = base * (sh + dynLight(p, n, mask));
  float f = 1.0 - exp(-depth * uFogDensity);
  return mix(c, uFogColor * (0.25 + 0.75 * sh), f);
}
`;

// Live sector heights: uDelta holds (live - map) height per slot (sector*2 + floor|ceil), 256 slots per row.
const DISP = `
uniform sampler2D uDelta;
float slotDelta(float b) {
  int i = int(b + 0.5);
  return texelFetch(uDelta, ivec2(i & 255, i >> 8), 0).r;
}
`;

export const GEO_VS = HEAD + DISP + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aTex;
layout(location=3) in float aSec;
layout(location=4) in float aAdj;
layout(location=5) in float aBind;
layout(location=6) in float aAnchor;
layout(location=7) in float aOther;
layout(location=8) in float aZo;
uniform mat4 uVP;
uniform sampler2D uInfo;
uniform sampler2D uSecLight;
out vec3 vPos;
out vec2 vUV;
flat out vec4 vInfo;
out float vLight;
out float vDepth;
flat out int vMask;
void main() {
  vec3 p = aPos;
  vec2 uv = aUV;
  if (aBind >= 0.0) {
    float d = slotDelta(aBind);
    p.z += d;
    if (aAnchor > -1.5) uv.y += (aAnchor >= 0.0 ? slotDelta(aAnchor) : 0.0) - d;
    if (aOther > 0.5) p.z = max(p.z, aZo + slotDelta(aOther - 1.0));
  }
  vec4 cp = uVP * vec4(p, 1.0);
  gl_Position = cp;
  vDepth = cp.w;
  vPos = p;
  vUV = uv;
  vInfo = texelFetch(uInfo, ivec2(int(aTex + 0.5), 0), 0);
  int s = int(aSec + 0.5);
  vec2 sl = texelFetch(uSecLight, ivec2(s & 255, s >> 8), 0).rg;
  vLight = sl.r + aAdj;
  vMask = int(sl.g + 0.5);
}
`;

export const GEO_FS = (masked) => HEAD + (masked ? '#define MASKED\n' : '') + `
in vec3 vPos;
in vec2 vUV;
flat in vec4 vInfo;
in float vLight;
in float vDepth;
flat in int vMask;
uniform sampler2DArray uTex;
uniform float uLodBias;
uniform float uClipZ;
${LIGHT}
out vec4 oColor;
// 4x4 ordered dither: mip level changes become a fine retro dither instead of hard bands (grazing-angle floors)
const float BAYER4[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  if (vPos.z > uClipZ) discard;
  vec2 size = vInfo.yz;
  vec2 dx = dFdx(vUV), dy = dFdy(vUV);
  float rho2 = max(dot(dx, dx), dot(dy, dy));
  float lod = 0.5 * log2(max(rho2, 1e-8)) + uLodBias;
  float maxl = floor(log2(max(size.x, size.y)));
  ivec2 fp = ivec2(gl_FragCoord.xy) & 3;
  float dither = (BAYER4[fp.y * 4 + fp.x] + 0.5) * (1.0 / 16.0);
  float k = clamp(floor(lod + dither), 0.0, maxl);
  vec2 szk = max(floor(size / exp2(k)), vec2(1.0));
  vec2 t = floor(vUV / exp2(k));
#ifdef MASKED
  if (vUV.y < 0.0 || vUV.y >= size.y) discard;
  t.x -= floor(t.x / szk.x) * szk.x;
  t.y = clamp(t.y, 0.0, szk.y - 1.0);
#else
  t -= floor(t / szk) * szk;
#endif
  vec4 c = texelFetch(uTex, ivec3(ivec2(t), int(vInfo.x + 0.5)), int(k));
  if (c.a < 0.5) discard;
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)) + vec3(1e-9));
  oColor = vec4(shadeColor(c.rgb, vLight, vDepth, vPos, n, vMask), 1.0);
}
`;

export const SKY_VS = HEAD + DISP + `
layout(location=0) in vec3 aPos;
layout(location=5) in float aBind;
layout(location=7) in float aOther;
layout(location=8) in float aZo;
uniform mat4 uVP;
out vec3 vPos;
void main() {
  vec3 p = aPos;
  if (aBind >= 0.0) {
    p.z += slotDelta(aBind);
    if (aOther > 0.5) p.z = max(p.z, aZo + slotDelta(aOther - 1.0));
  }
  gl_Position = uVP * vec4(p, 1.0);
  vPos = p;
}
`;

export const SKY_FS = HEAD + `
in vec3 vPos;
uniform vec3 uCam;
uniform sampler2D uSky;
uniform vec2 uSkySize;
uniform vec3 uFogColor;
uniform float uClipZ;
out vec4 oColor;
void main() {
  if (vPos.z > uClipZ) discard;
  vec3 d = normalize(vPos - uCam);
  float ang = atan(d.y, d.x);
  // 4 repeats around the horizon, mirrored so it reads left-to-right like vanilla Doom
  float u = -ang * (1.0 / 6.2831853) * uSkySize.x * 4.0;
  float tn = d.z / max(length(d.xy), 1e-4);
  float v = 100.0 * (uSkySize.y / 128.0) - 160.0 * tn * (uSkySize.y / 128.0);
  ivec2 tc = ivec2(int(floor(u - floor(u / uSkySize.x) * uSkySize.x)), int(clamp(floor(v), 0.0, uSkySize.y - 1.0)));
  oColor = vec4(texelFetch(uSky, tc, 0).rgb, 1.0);
}
`;

export const SPR_VS = HEAD + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLight;
layout(location=3) in float aFb;
layout(location=4) in float aMask;
uniform mat4 uVP;
out vec3 vPos;
out vec2 vUV;
out float vLight;
out float vFb;
out float vDepth;
flat out int vMask;
void main() {
  vec4 cp = uVP * vec4(aPos, 1.0);
  gl_Position = cp;
  vDepth = cp.w; vPos = aPos; vUV = aUV; vLight = aLight; vFb = aFb; vMask = int(aMask + 0.5);
}
`;

export const SPR_FS = HEAD + `
in vec3 vPos;
in vec2 vUV;
in float vLight;
in float vFb;
in float vDepth;
flat in int vMask;
uniform sampler2D uAtlas;
${LIGHT}
out vec4 oColor;
void main() {
  vec4 c = texture(uAtlas, vUV);
  if (c.a < 0.5) discard;
  vec3 n = normalize(uCam - vPos);
  vec3 lit = shadeColor(c.rgb, vLight, vDepth, vPos, n, vMask);
  oColor = vec4(mix(lit, c.rgb, vFb), 1.0);
}
`;

export const POST_VS = HEAD + `
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BRIGHT_FS = HEAD + `
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
out vec4 oColor;
void main() {
  vec3 c = texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float w = smoothstep(uThreshold, uThreshold + 0.25, l);
  oColor = vec4(c * w, 1.0);
}
`;

export const BLUR_FS = HEAD + `
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uDir; // texel step
out vec4 oColor;
void main() {
  vec3 c = texture(uSrc, vUV).rgb * 0.2270270;
  c += (texture(uSrc, vUV + uDir * 1.3846154).rgb + texture(uSrc, vUV - uDir * 1.3846154).rgb) * 0.3162162;
  c += (texture(uSrc, vUV + uDir * 3.2307692).rgb + texture(uSrc, vUV - uDir * 3.2307692).rgb) * 0.0702703;
  oColor = vec4(c, 1.0);
}
`;

export const COMPOSITE_FS = HEAD + `
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler3D uLut;
uniform float uBloomStrength;
uniform float uClassic;     // palette-quantise through the LUT
uniform float uGamma;
uniform float uVignette;
out vec4 oColor;
const mat4 BAYER = mat4(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  vec3 c = texture(uScene, vUV).rgb;
  if (uBloomStrength > 0.0) c += texture(uBloom, vUV).rgb * uBloomStrength;
  vec2 q = vUV - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  c = pow(max(c, 0.0), vec3(1.0 / uGamma));
  if (uClassic > 0.5) {
    ivec2 p = ivec2(gl_FragCoord.xy) & 3;
    float b = BAYER[p.x][p.y] * (1.0 / 16.0) - 0.5;
    c += b * (1.0 / 28.0);
    c = texture(uLut, clamp(c, 0.0, 1.0) * (31.0 / 32.0) + 0.5 / 32.0).rgb;
  }
  oColor = vec4(c, 1.0);
}
`;
