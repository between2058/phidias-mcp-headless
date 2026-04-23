/**
 * Lightweight HTTP client for Phidias backend services.
 * Calls Qwen and Trellis.2 APIs directly (no Next.js proxy needed).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const QWEN_API_URL = process.env.QWEN_API_URL ?? 'http://172.18.245.177:8190';
const TRELLIS2_API_URL = process.env.TRELLIS2_API_URL ?? 'http://172.18.245.177:52070';
const RECONVIAGEN_API_URL = process.env.RECONVIAGEN_API_URL ?? 'http://172.18.245.177:52069';
const P3SAM_API_URL = process.env.P3SAM_API_URL ?? 'http://172.18.245.177:5001';

const OUTPUT_DIR = path.join(os.tmpdir(), 'phidias-mcp');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Session asset tracking
// ---------------------------------------------------------------------------

export interface GeneratedAsset {
  id: string;
  type: 'image' | 'model';
  filePath: string;
  prompt?: string;
  sourceImagePath?: string;
  createdAt: string;
  backendRequestId?: string;
}

const sessionAssets: GeneratedAsset[] = [];

export function getSessionAssets(): GeneratedAsset[] {
  return [...sessionAssets];
}

export function findAssetById(id: string): GeneratedAsset | undefined {
  return sessionAssets.find((a) => a.id === id);
}

export function trackSessionAsset(asset: GeneratedAsset): void {
  sessionAssets.push(asset);
}

export function getOutputDir(): string {
  return OUTPUT_DIR;
}

// ---------------------------------------------------------------------------
// Qwen: Text-to-Image
// ---------------------------------------------------------------------------

interface QwenJobSubmitResponse {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  queue_position: number;
}

interface QwenJobPollResponse {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: {
    status: string;
    request_id: string;
    urls?: string[];
    result_urls?: string[];
    seeds?: number[];
  };
  error?: { error_code: string; message: string };
}

/**
 * Generate an image from a text prompt via Qwen text2img.
 * Handles the full lifecycle: submit → poll → download → save to disk.
 */
export async function generateImage(
  prompt: string,
  params: {
    seed?: number;
    num_steps?: number;
    cfg_scale?: number;
    negative_prompt?: string;
    aspect_ratio?: string;
  } = {},
): Promise<GeneratedAsset> {
  // 1. Submit job
  const formBody = new URLSearchParams();
  formBody.append('prompt', prompt);
  if (params.seed !== undefined) formBody.append('seed', String(params.seed));
  if (params.num_steps !== undefined) formBody.append('num_steps', String(params.num_steps));
  if (params.cfg_scale !== undefined) formBody.append('cfg_scale', String(params.cfg_scale));
  if (params.negative_prompt) formBody.append('negative_prompt', params.negative_prompt);
  if (params.aspect_ratio) formBody.append('aspect_ratio', params.aspect_ratio);

  const submitRes = await fetch(`${QWEN_API_URL}/text2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Qwen text2img submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = (await submitRes.json()) as QwenJobSubmitResponse;
  const jobId = submitData.job_id;

  // 2. Poll until completed
  const POLL_TIMEOUT_MS = 300_000; // 5 min
  const POLL_INTERVAL_MS = 3_000;
  const startedAt = Date.now();

  let result: QwenJobPollResponse['result'] | null = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const pollRes = await fetch(`${QWEN_API_URL}/jobs/${jobId}`);
    if (!pollRes.ok) {
      throw new Error(`Qwen poll failed (${pollRes.status})`);
    }

    const pollData = (await pollRes.json()) as QwenJobPollResponse;

    if (pollData.status === 'completed' && pollData.result) {
      result = pollData.result;
      break;
    }
    if (pollData.status === 'failed') {
      throw new Error(`Qwen job failed: ${pollData.error?.message ?? 'unknown error'}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!result) {
    throw new Error('Qwen text2img polling timed out after 5 minutes');
  }

  // 3. Download the first image
  const urls = result.urls ?? result.result_urls ?? [];
  if (urls.length === 0) {
    throw new Error('Qwen returned no image URLs');
  }

  const imageUrl = urls[0];
  const fileName = imageUrl.split('/').pop() || 'output.png';
  const downloadId = result.request_id || jobId;

  const downloadRes = await fetch(`${QWEN_API_URL}/download/${downloadId}/${fileName}`);
  if (!downloadRes.ok) {
    throw new Error(`Image download failed (${downloadRes.status})`);
  }

  const imageBuffer = Buffer.from(await downloadRes.arrayBuffer());
  const outputPath = path.join(OUTPUT_DIR, `img_${Date.now()}_${fileName}`);
  fs.writeFileSync(outputPath, imageBuffer);

  // 4. Track asset
  const asset: GeneratedAsset = {
    id: `img_${Date.now()}`,
    type: 'image',
    filePath: outputPath,
    prompt,
    createdAt: new Date().toISOString(),
    backendRequestId: downloadId,
  };
  sessionAssets.push(asset);

  return asset;
}

// ---------------------------------------------------------------------------
// Trellis.2: Image-to-3D
// ---------------------------------------------------------------------------

interface Trellis2GenerateResponse {
  request_id: string;
  glb_url: string;
  gaussian_video?: string;
  radiance_video?: string;
  mesh_video?: string;
  ply_url?: string;
}

/**
 * Raw ReconViaGen upstream response. Unlike Trellis.2, there is no
 * request_id field; downloads are keyed by the polling jobId and the
 * filename is derived from glb_file. Field names also differ
 * (glb_file/ply_file vs glb_url/ply_url).
 */
interface ReconViaGenGenerateResponse {
  glb_file: string;
  gaussian_video?: string;
  radiance_video?: string;
  mesh_video?: string;
  ply_file?: string;
}

/**
 * Generate a 3D model from a reference image.
 * Supports two backends:
 * - trellis2: High quality, detailed topology, slower (~3min). Direct result.
 * - reconviagen: Fast (~1min), lower detail. Uses polling.
 */
export async function generate3D(
  imagePath: string,
  params: {
    backend?: 'trellis2' | 'reconviagen';
    seed?: number;
    texture_size?: number;
    ss_guidance_strength?: number;
    ss_sampling_steps?: number;
    slat_guidance_strength?: number;
    slat_sampling_steps?: number;
  } = {},
): Promise<GeneratedAsset> {
  const backend = params.backend ?? 'trellis2';

  // 1. Read image from disk
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const imageBuffer = fs.readFileSync(imagePath);
  const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

  // 2. Build multipart form
  const formData = new FormData();
  formData.append('file', imageBlob, path.basename(imagePath));
  if (params.seed !== undefined) formData.append('seed', String(params.seed));
  if (params.texture_size !== undefined) formData.append('texture_size', String(params.texture_size));
  if (params.ss_guidance_strength !== undefined) formData.append('ss_guidance_strength', String(params.ss_guidance_strength));
  if (params.ss_sampling_steps !== undefined) formData.append('ss_sampling_steps', String(params.ss_sampling_steps));
  if (params.slat_guidance_strength !== undefined) formData.append('slat_guidance_strength', String(params.slat_guidance_strength));
  if (params.slat_sampling_steps !== undefined) formData.append('slat_sampling_steps', String(params.slat_sampling_steps));

  let glbBuffer: Buffer;
  let requestId: string;

  if (backend === 'trellis2') {
    // Trellis.2: direct result, no polling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000);

    let res: Response;
    try {
      res = await fetch(`${TRELLIS2_API_URL}/generate`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Trellis.2 generate failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as Trellis2GenerateResponse;
    requestId = data.request_id;

    const glbFileName = data.glb_url.split('/').pop() || 'model.glb';
    const downloadRes = await fetch(
      `${TRELLIS2_API_URL}/download/${data.request_id}/${glbFileName}`,
    );
    if (!downloadRes.ok) {
      throw new Error(`GLB download failed (${downloadRes.status})`);
    }
    glbBuffer = Buffer.from(await downloadRes.arrayBuffer());
  } else {
    // ReconViaGen: polling-based
    const submitRes = await fetch(`${RECONVIAGEN_API_URL}/generate-single`, {
      method: 'POST',
      body: formData,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      throw new Error(`ReconViaGen submit failed (${submitRes.status}): ${errText}`);
    }

    const submitData = (await submitRes.json()) as { job_id: string; status: string };
    const jobId = submitData.job_id;

    // Poll until completed
    const POLL_TIMEOUT_MS = 300_000;
    const POLL_INTERVAL_MS = 3_000;
    const startedAt = Date.now();
    let result: ReconViaGenGenerateResponse | null = null;

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const pollRes = await fetch(`${RECONVIAGEN_API_URL}/jobs/${jobId}`);
      if (!pollRes.ok) throw new Error(`ReconViaGen poll failed (${pollRes.status})`);

      const pollData = (await pollRes.json()) as {
        status: string;
        result?: ReconViaGenGenerateResponse;
        error?: { message: string };
      };

      if (pollData.status === 'completed' && pollData.result) {
        result = pollData.result;
        break;
      }
      if (pollData.status === 'failed') {
        throw new Error(`ReconViaGen job failed: ${pollData.error?.message ?? 'unknown'}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (!result) throw new Error('ReconViaGen polling timed out after 5 minutes');

    requestId = jobId;
    const glbFileName = result.glb_file.split('/').pop() || 'model.glb';
    const downloadRes = await fetch(
      `${RECONVIAGEN_API_URL}/download/${jobId}/${glbFileName}`,
    );
    if (!downloadRes.ok) {
      throw new Error(`GLB download failed (${downloadRes.status})`);
    }
    glbBuffer = Buffer.from(await downloadRes.arrayBuffer());
  }

  // Save to disk
  const outputPath = path.join(OUTPUT_DIR, `model_${Date.now()}_output.glb`);
  fs.writeFileSync(outputPath, glbBuffer);

  // Track asset
  const asset: GeneratedAsset = {
    id: `model_${Date.now()}`,
    type: 'model',
    filePath: outputPath,
    sourceImagePath: imagePath,
    createdAt: new Date().toISOString(),
    backendRequestId: requestId,
  };
  sessionAssets.push(asset);

  return asset;
}

// ---------------------------------------------------------------------------
// P3-SAM: 3D Model Segmentation
// ---------------------------------------------------------------------------

export interface SegmentResult {
  filePath: string;
  numParts: number;
  requestId: string;
}

/**
 * Segment a 3D model into parts via P3-SAM.
 * Polling-based: submit → poll → download segmented GLB.
 */
export async function segment3D(
  glbPath: string,
  params: {
    point_num?: number;
    prompt_num?: number;
    threshold?: number;
    seed?: number;
  } = {},
): Promise<SegmentResult> {
  if (!fs.existsSync(glbPath)) {
    throw new Error(`GLB file not found: ${glbPath}`);
  }

  const glbBuffer = fs.readFileSync(glbPath);
  const glbBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' });

  // 1. Submit segmentation job
  const formData = new FormData();
  formData.append('file', glbBlob, path.basename(glbPath));
  if (params.point_num !== undefined) formData.append('point_num', String(params.point_num));
  if (params.prompt_num !== undefined) formData.append('prompt_num', String(params.prompt_num));
  if (params.threshold !== undefined) formData.append('threshold', String(params.threshold));
  if (params.seed !== undefined) formData.append('seed', String(params.seed));

  const submitRes = await fetch(`${P3SAM_API_URL}/segment`, {
    method: 'POST',
    body: formData,
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`P3-SAM submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = (await submitRes.json()) as { job_id: string; status: string };
  const jobId = submitData.job_id;

  // 2. Poll until completed
  const POLL_TIMEOUT_MS = 300_000;
  const POLL_INTERVAL_MS = 3_000;
  const startedAt = Date.now();

  interface P3SAMResult {
    status: string;
    request_id: string;
    num_parts: number;
    // Newer backend returns `segmented_glb` as a download path like
    // "/download/<request_id>/<filename>". Older builds used `segmented_glb_url`.
    segmented_glb?: string;
    segmented_glb_url?: string;
  }

  let result: P3SAMResult | null = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const pollRes = await fetch(`${P3SAM_API_URL}/jobs/${jobId}`);
    if (!pollRes.ok) throw new Error(`P3-SAM poll failed (${pollRes.status})`);

    const pollData = (await pollRes.json()) as {
      status: string;
      result?: P3SAMResult;
      error?: { message: string };
    };

    if (pollData.status === 'completed' && pollData.result) {
      result = pollData.result;
      break;
    }
    if (pollData.status === 'failed') {
      throw new Error(`P3-SAM job failed: ${pollData.error?.message ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!result) throw new Error('P3-SAM polling timed out after 5 minutes');

  const segmentedPath = result.segmented_glb ?? result.segmented_glb_url;
  if (!segmentedPath) {
    throw new Error(
      `P3-SAM returned completed status but no segmented_glb path. Full result: ${JSON.stringify(result)}`,
    );
  }

  // 3. Download segmented GLB
  // `segmentedPath` looks like "/download/<request_id>/<filename>"; take the last
  // segment as the filename we want to save locally.
  const glbFileName = segmentedPath.split('/').pop() || 'segmented.glb';
  const downloadId = result.request_id || jobId;
  const downloadRes = await fetch(
    `${P3SAM_API_URL}/download/${downloadId}/${glbFileName}`,
  );

  if (!downloadRes.ok) {
    throw new Error(`Segmented GLB download failed (${downloadRes.status})`);
  }

  const segBuffer = Buffer.from(await downloadRes.arrayBuffer());
  const outputPath = path.join(OUTPUT_DIR, `segmented_${Date.now()}_${glbFileName}`);
  fs.writeFileSync(outputPath, segBuffer);

  // Track asset
  const asset: GeneratedAsset = {
    id: `seg_${Date.now()}`,
    type: 'model',
    filePath: outputPath,
    sourceImagePath: glbPath,
    createdAt: new Date().toISOString(),
    backendRequestId: downloadId,
  };
  sessionAssets.push(asset);

  return {
    filePath: outputPath,
    numParts: result.num_parts,
    requestId: downloadId,
  };
}
