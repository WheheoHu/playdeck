//!HOOK OUTPUT
//!BIND HOOKED
//!DESC PlayDeck waveform and CIE 1976 gamut

// The OUTPUT hook's texture is the fitted picture, not the window. Black bars live outside it,
// so samples run across the whole texture and the card is placed in that same pixel space.
// PQ selects a nit scale. PRIM is 0 BT.709, 1 BT.2020, 2 Display P3. LUMA selects the luma waveform.
const float PQ = @PQ@;
const float PRIM = @PRIM@;
const float PEAK = @PEAK@;
const float LUMA = @LUMA@;
const float RADIUS = @RADIUS@;
const vec4 CARD = vec4(@CARD_X@, @CARD_Y@, @CARD_W@, @CARD_H@);
const vec4 WAVE = vec4(@WAVE_X@, @WAVE_Y@, @WAVE_W@, @WAVE_H@);
const vec4 GAMUT = vec4(@GAMUT_X@, @GAMUT_Y@, @GAMUT_S@, @GAMUT_S@);

const int WF_N = 96;
const int GM_X = 18;
const int GM_Y = 12;

float pq_eotf(float x) {
    float m2 = 78.84375;
    float m1 = 0.1593017578125;
    float c1 = 0.8359375;
    float c2 = 18.8515625;
    float c3 = 18.6875;
    float p = pow(max(x, 0.0), 1.0 / m2);
    float n = max(p - c1, 0.0) / max(c2 - c3 * p, 1e-6);
    return pow(n, 1.0 / m1) * 10000.0;
}

float pq_oetf(float nits) {
    float m1 = 0.1593017578125;
    float m2 = 78.84375;
    float c1 = 0.8359375;
    float c2 = 18.8515625;
    float c3 = 18.6875;
    float p = pow(clamp(nits, 0.0, 10000.0) / 10000.0, m1);
    return pow((c1 + c2 * p) / (1.0 + c3 * p), m2);
}

vec3 linearize(vec3 c) {
    if (PQ > 0.5) return vec3(pq_eotf(c.r), pq_eotf(c.g), pq_eotf(c.b));
    return pow(max(c, vec3(0.0)), vec3(2.2));
}

vec3 luma_coef() {
    if (PRIM > 1.5) return vec3(0.2289746, 0.6917385, 0.0792869);
    if (PRIM > 0.5) return vec3(0.2627002, 0.6779981, 0.0593017);
    return vec3(0.2126390, 0.7151687, 0.0721923);
}

float luma_code(vec3 pix) {
    vec3 lin = linearize(clamp(pix, 0.0, 1.0));
    float y = dot(lin, luma_coef());
    if (PQ > 0.5) return pq_oetf(y);
    return pow(max(y, 0.0), 1.0 / 2.2);
}

vec3 to_xyz(vec3 rgb) {
    if (PRIM > 1.5) {
        return mat3(
            0.4865709, 0.2289746, 0.0000000,
            0.2656677, 0.6917385, 0.0451134,
            0.1982173, 0.0792869, 1.0439444) * rgb;
    }
    if (PRIM > 0.5) {
        return mat3(
            0.6369580, 0.2627002, 0.0000000,
            0.1446169, 0.6779981, 0.0280727,
            0.1688810, 0.0593017, 1.0609851) * rgb;
    }
    return mat3(
        0.4123908, 0.2126390, 0.0193308,
        0.3575843, 0.7151687, 0.1191948,
        0.1804808, 0.0721923, 0.9505322) * rgb;
}

vec3 encode(vec3 linear_srgb) {
    vec3 c = clamp(linear_srgb, 0.0, 1.0);
    if (PQ < 0.5) return pow(c, vec3(1.0 / 2.2));
    vec3 nits = mat3(
        0.6274039, 0.0690973, 0.0163914,
        0.3292830, 0.9195404, 0.0880133,
        0.0433131, 0.0113623, 0.8955953) * c * PEAK;
    return vec3(pq_oetf(nits.r), pq_oetf(nits.g), pq_oetf(nits.b));
}

vec3 from_srgb(vec3 srgb) {
    return encode(pow(clamp(srgb, 0.0, 1.0), vec3(2.2)));
}

vec2 xy_to_uv(vec2 xy) {
    float d = -2.0 * xy.x + 12.0 * xy.y + 3.0;
    return vec2(4.0 * xy.x, 9.0 * xy.y) / max(d, 1e-6);
}

vec2 uv_of(vec3 xyz) {
    float d = xyz.x + 15.0 * xyz.y + 3.0 * xyz.z;
    if (d <= 1e-5) return xy_to_uv(vec2(0.3127, 0.3290));
    return vec2(4.0 * xyz.x, 9.0 * xyz.y) / d;
}

float segdist(vec2 p, vec2 a, vec2 b) {
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
    return length(p - (a + t * ab));
}

float stroke(float dist) {
    // Screen-pixel radius of a gamut line. A wide falloff keeps diagonals from stair-stepping;
    // derivatives are unreliable inside the plot branch, so the scale comes from the plot size.
    float px = dist * max(GAMUT.z, 1.0) / 0.62;
    return 1.0 - smoothstep(0.35, 2.15, px);
}

// CIE 1931 2° spectral locus, 10 nm steps, closed by the purple line back to the first point.
const int LOCUS_N = 23;
const vec2 LOCUS[23] = vec2[23](
    vec2(0.1741, 0.0050), vec2(0.1566, 0.0177), vec2(0.1440, 0.0297), vec2(0.1241, 0.0578),
    vec2(0.0913, 0.1327), vec2(0.0454, 0.2950), vec2(0.0082, 0.5384), vec2(0.0139, 0.7502),
    vec2(0.0743, 0.8338), vec2(0.1547, 0.8059), vec2(0.2296, 0.7543), vec2(0.3016, 0.6923),
    vec2(0.3731, 0.6245), vec2(0.4441, 0.5547), vec2(0.5125, 0.4866), vec2(0.5752, 0.4242),
    vec2(0.6270, 0.3725), vec2(0.6658, 0.3340), vec2(0.6915, 0.3083), vec2(0.7079, 0.2920),
    vec2(0.7190, 0.2809), vec2(0.7260, 0.2740), vec2(0.7347, 0.2653)
);

float tri_dist(vec2 p, vec2 a, vec2 b, vec2 c) {
    return min(segdist(p, a, b), min(segdist(p, b, c), segdist(p, c, a)));
}

float round_rect(vec2 px, vec4 r, float rad) {
    vec2 q = abs(px - (r.xy + r.zw * 0.5)) - r.zw * 0.5 + vec2(rad);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}

bool inside(vec2 px, vec4 r) {
    return px.x >= r.x && px.y >= r.y && px.x <= r.x + r.z && px.y <= r.y + r.w;
}

vec3 over(vec3 dst, vec3 src, float a) {
    return mix(dst, src, clamp(a, 0.0, 1.0));
}

vec4 hook() {
    vec2 px = HOOKED_pos * HOOKED_size;
    vec4 src = HOOKED_tex(HOOKED_pos);
    float edge = round_rect(px, CARD, max(RADIUS, 0.0));
    if (edge > 1.35) return src;

    float cover = 1.0 - smoothstep(0.0, 1.35, edge);
    // Same glass as the ASS stats cards: SURFACE #17171D at alpha 0x28.
    vec3 glass = from_srgb(vec3(23.0, 23.0, 29.0) / 255.0);
    vec3 col = mix(src.rgb, glass, 0.843 * cover);

    if (inside(px, WAVE) && HOOKED_size.x > 1.0 && HOOKED_size.y > 1.0) {
        float ycode = clamp(1.0 - (px.y - WAVE.y) / max(WAVE.w, 1.0), 0.0, 1.0);
        float xnorm = clamp((px.x - WAVE.x) / max(WAVE.z, 1.0), 0.0, 1.0);
        vec3 trace = vec3(0.0);
        for (int i = 0; i < WF_N; i++) {
            float yn = (float(i) + 0.5) / float(WF_N);
            vec3 pix = HOOKED_tex(vec2(xnorm, yn)).rgb;
            if (LUMA > 0.5) {
                float delta = (luma_code(pix) - ycode) * WAVE.w;
                trace += vec3(exp(-delta * delta * 1.15));
            } else {
                vec3 code = clamp(pix, 0.0, 1.0);
                vec3 delta = (code - vec3(ycode)) * WAVE.w;
                trace += exp(-delta * delta * 1.15);
            }
        }
        trace = trace / float(WF_N) * 9.0;
        vec3 painted = encode(clamp(vec3(trace.r, trace.g * 0.92, trace.b), 0.0, 1.0));
        col = vec3(
            mix(col.r, painted.r, clamp(trace.r, 0.0, 1.0)),
            mix(col.g, painted.g, clamp(trace.g, 0.0, 1.0)),
            mix(col.b, painted.b, clamp(trace.b, 0.0, 1.0)));

        float marks[7] = float[7](pq_oetf(10000.0), pq_oetf(4000.0), pq_oetf(1000.0), pq_oetf(203.0), pq_oetf(100.0), pq_oetf(10.0), pq_oetf(1.0));
        float sdr_marks[5] = float[5](1.0, 0.75, 0.5, 0.25, 0.0);
        vec3 grid = from_srgb(vec3(0.62, 0.60, 0.58));
        vec3 accent = from_srgb(vec3(0.90, 0.63, 0.05));
        if (PQ > 0.5) {
            for (int m = 0; m < 7; m++) {
                float my = WAVE.y + WAVE.w * (1.0 - marks[m]);
                col = over(col, m == 3 ? accent : grid, (1.0 - smoothstep(0.2, 1.15, abs(px.y - my))) * 0.72);
            }
        } else {
            for (int m = 0; m < 5; m++) {
                float my = WAVE.y + WAVE.w * (1.0 - sdr_marks[m]);
                col = over(col, grid, (1.0 - smoothstep(0.2, 1.15, abs(px.y - my))) * 0.65);
            }
        }
    }

    if (inside(px, GAMUT) && HOOKED_size.x > 1.0 && HOOKED_size.y > 1.0) {
        float u = 0.62 * clamp((px.x - GAMUT.x) / max(GAMUT.z, 1.0), 0.0, 1.0);
        float v = 0.62 * clamp(1.0 - (px.y - GAMUT.y) / max(GAMUT.w, 1.0), 0.0, 1.0);
        vec2 p = vec2(u, v);
        vec3 cloud = vec3(0.0);
        for (int y = 0; y < GM_Y; y++) {
            for (int x = 0; x < GM_X; x++) {
                vec2 tuv = (vec2(float(x), float(y)) + 0.5) / vec2(float(GM_X), float(GM_Y));
                vec3 lin = linearize(HOOKED_tex(tuv).rgb);
                float mag = max(lin.r, max(lin.g, lin.b));
                vec2 uv = uv_of(to_xyz(lin));
                float w = exp(-dot(uv - p, uv - p) * 14000.0);
                cloud += (lin / max(mag, 1e-4)) * w;
            }
        }
        cloud = cloud / float(GM_X * GM_Y) * 22.0;
        vec3 cloud_code = encode(clamp(cloud, 0.0, 1.0));
        float cloud_a = clamp(max(cloud.r, max(cloud.g, cloud.b)), 0.0, 1.0);
        col = over(col, cloud_code, cloud_a);

        float locus = 10.0;
        vec2 first = xy_to_uv(LOCUS[0]);
        vec2 prev = first;
        for (int i = 1; i < LOCUS_N; i++) {
            vec2 cur = xy_to_uv(LOCUS[i]);
            locus = min(locus, segdist(p, prev, cur));
            prev = cur;
        }
        locus = min(locus, segdist(p, prev, first));
        col = over(col, from_srgb(vec3(0.82, 0.82, 0.84)), stroke(locus) * 0.9);

        vec2 r709 = xy_to_uv(vec2(0.640, 0.330));
        vec2 g709 = xy_to_uv(vec2(0.300, 0.600));
        vec2 b709 = xy_to_uv(vec2(0.150, 0.060));
        vec2 rp3 = xy_to_uv(vec2(0.680, 0.320));
        vec2 gp3 = xy_to_uv(vec2(0.265, 0.690));
        vec2 bp3 = xy_to_uv(vec2(0.150, 0.060));
        vec2 r2020 = xy_to_uv(vec2(0.708, 0.292));
        vec2 g2020 = xy_to_uv(vec2(0.170, 0.797));
        vec2 b2020 = xy_to_uv(vec2(0.131, 0.046));
        col = over(col, from_srgb(vec3(0.62, 0.48, 0.95)), stroke(tri_dist(p, r2020, g2020, b2020)) * 0.95);
        col = over(col, from_srgb(vec3(0.90, 0.63, 0.08)), stroke(tri_dist(p, rp3, gp3, bp3)) * 0.95);
        col = over(col, from_srgb(vec3(0.25, 0.78, 0.74)), stroke(tri_dist(p, r709, g709, b709)) * 0.95);

        vec2 d65 = xy_to_uv(vec2(0.3127, 0.3290));
        float dx = abs(p.x - d65.x);
        float dy = abs(p.y - d65.y);
        float crosshair = min(mix(dy, 1.0, step(0.012, dx)), mix(dx, 1.0, step(0.012, dy)));
        col = over(col, from_srgb(vec3(0.95)), stroke(crosshair));
    }

    return vec4(mix(src.rgb, col, cover), src.a);
}
