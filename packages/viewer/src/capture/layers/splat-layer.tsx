'use client'

import { type GaussianSplatData, parseGaussianSplatPly } from '@pascal-app/core/capture'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cameraProjectionMatrix,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  ivec2,
  length,
  mat3,
  max,
  min,
  modelViewMatrix,
  normalize,
  positionGeometry,
  select,
  sqrt,
  step,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportSize,
} from 'three/tsl'
import {
  BufferAttribute,
  DataTexture,
  DoubleSide,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three/webgpu'
import { OVERLAY_LAYER } from '../../lib/layers'
import { rewriteLoopbackAssetUrl } from '../asset-url'
import {
  buildSplatTextures,
  createSortScratch,
  SPLAT_TEXTURE_WIDTH,
  type SplatTextures,
  sortSplatsBackToFront,
} from './splat-data'

const NO_RAYCAST = () => undefined
/** The sorted order is rebuilt when the view turns or moves more than this, at most every 80 ms. */
const RESORT_DOT = 0.9995
const RESORT_DISTANCE = 0.02
const RESORT_MILLIS = 80
/** A splat's quad reaches this many standard deviations from its centre. */
const EXTENT_SIGMAS = 3

function dataTexture(
  data: Float32Array | Uint8Array,
  width: number,
  height: number,
  type: typeof FloatType | typeof UnsignedByteType,
): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, type)
  texture.magFilter = NearestFilter
  texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * The splats as one instanced quad per splat, drawn back to front with alpha blending. Each quad
 * is projected as the 3D Gaussian's 2D footprint (the EWA splatting of the original 3DGS paper:
 * the 3D covariance through the view rotation and the projection's Jacobian, plus a 0.3 px
 * low-pass), in a node material so it runs on the WebGPU renderer and on its WebGL 2 fallback.
 * Spark and other WebGL libraries need a `WebGLRenderer`, which the viewer does not use.
 */
function createSplatObjects(data: GaussianSplatData, textures: SplatTextures) {
  const { width, height } = textures
  const centreTexture = dataTexture(textures.centres, width, height, FloatType)
  const colourTexture = dataTexture(textures.colours, width, height, UnsignedByteType)
  const covarianceATexture = dataTexture(textures.covarianceA, width, height, FloatType)
  const covarianceBTexture = dataTexture(textures.covarianceB, width, height, FloatType)

  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  )
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const order = new Float32Array(data.count)
  for (let index = 0; index < data.count; index += 1) order[index] = index
  const orderAttribute = new InstancedBufferAttribute(order, 1)
  geometry.setAttribute('splatOrder', orderAttribute)
  geometry.instanceCount = data.count

  const opacityUniform = uniform(1)
  // The TSL typings do not model matrix columns or instanced scalar attributes; the shader
  // graph is checked by running it (see the capture viewer tests and the browser check).
  // biome-ignore lint/suspicious/noExplicitAny: TSL node typings
  const index: any = instancedBufferAttribute(orderAttribute, 'float')
  const row = index.div(SPLAT_TEXTURE_WIDTH).floor()
  const coord = ivec2(index.sub(row.mul(SPLAT_TEXTURE_WIDTH)).toInt(), row.toInt())
  const centre = textureLoad(centreTexture, coord)
  const covA = textureLoad(covarianceATexture, coord)
  const covB = textureLoad(covarianceBTexture, coord)
  const sigma = mat3(
    vec3(covA.x, covA.y, covA.z),
    vec3(covA.y, covA.w, covB.x),
    vec3(covA.z, covB.x, covB.y),
  )

  const viewPosition = modelViewMatrix.mul(vec4(centre.xyz, 1)).xyz
  const depth = viewPosition.z.negate()
  // biome-ignore lint/suspicious/noExplicitAny: TSL node typings
  const mv: any = modelViewMatrix
  // biome-ignore lint/suspicious/noExplicitAny: TSL node typings
  const projection: any = cameraProjectionMatrix
  const rotation0 = mv[0].xyz
  const rotation1 = mv[1].xyz
  const rotation2 = mv[2].xyz
  // Rows of the model-view rotation.
  const row0 = vec3(rotation0.x, rotation1.x, rotation2.x)
  const row1 = vec3(rotation0.y, rotation1.y, rotation2.y)
  const row2 = vec3(rotation0.z, rotation1.z, rotation2.z)
  const focal = vec2(projection[0].x, projection[1].y).mul(viewportSize).mul(0.5)
  const inverseDepth = float(1).div(max(depth, 0.001))
  // Rows of J * W, with J the Jacobian of the perspective projection at the splat's centre.
  const m0 = row0
    .mul(focal.x.mul(inverseDepth))
    .add(row2.mul(focal.x.mul(viewPosition.x).mul(inverseDepth).mul(inverseDepth)))
  const m1 = row1
    .mul(focal.y.mul(inverseDepth))
    .add(row2.mul(focal.y.mul(viewPosition.y).mul(inverseDepth).mul(inverseDepth)))
  const sigmaM0 = sigma.mul(m0)
  const sigmaM1 = sigma.mul(m1)
  const a = dot(m0, sigmaM0).add(0.3)
  const b = dot(m0, sigmaM1)
  const c = dot(m1, sigmaM1).add(0.3)
  const mid = a.add(c).mul(0.5)
  const half = a.sub(c).mul(0.5)
  const radius = sqrt(max(half.mul(half).add(b.mul(b)), 0.0001))
  const lambda1 = mid.add(radius)
  const lambda2 = max(mid.sub(radius), 0.05)
  const direction = vec2(b, lambda1.sub(a))
  const axis = select(length(direction).greaterThan(0.000001), normalize(direction), vec2(1, 0))
  const sigma1 = min(sqrt(lambda1), 340 / EXTENT_SIGMAS)
  const sigma2 = min(sqrt(lambda2), 340 / EXTENT_SIGMAS)
  const corner = positionGeometry.xy.mul(EXTENT_SIGMAS)
  const offsetPixels = axis
    .mul(sigma1)
    .mul(corner.x)
    .add(vec2(axis.y, axis.x.negate()).mul(sigma2).mul(corner.y))
  const clip = cameraProjectionMatrix.mul(vec4(viewPosition, 1))
  const ndcOffset = offsetPixels.mul(2).div(viewportSize)
  const position = vec4(clip.xy.add(ndcOffset.mul(clip.w)), clip.z, clip.w)
  const inView = depth
    .greaterThan(0.05)
    .and(clip.x.abs().lessThan(clip.w.mul(1.4)))
    .and(clip.y.abs().lessThan(clip.w.mul(1.4)))
    .and(centre.w.greaterThan(1 / 255))

  const vertexCorner = varying(corner, 'splatCorner')
  const colour = textureLoad(colourTexture, coord)
  const vertexColour = varying(vec4(colour.rgb, centre.w), 'splatColour')

  const material = new MeshBasicNodeMaterial()
  material.vertexNode = select(inView, position, vec4(0, 0, 2, 1))
  const falloff = dot(vertexCorner, vertexCorner)
  material.colorNode = vertexColour.rgb
  material.opacityNode = vertexColour.a
    .mul(exp(falloff.mul(-0.5)))
    .mul(step(falloff, float(EXTENT_SIGMAS * EXTENT_SIGMAS)))
    .mul(opacityUniform)
  material.transparent = true
  material.depthWrite = false
  material.depthTest = false
  material.side = DoubleSide
  material.toneMapped = false
  material.fog = false

  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.raycast = NO_RAYCAST
  mesh.name = 'capture-gaussian-splat'
  mesh.layers.set(OVERLAY_LAYER)

  const dispose = () => {
    geometry.dispose()
    material.dispose()
    for (const texture of [centreTexture, colourTexture, covarianceATexture, covarianceBTexture]) {
      texture.dispose()
    }
  }
  return { mesh, order, orderAttribute, opacityUniform, dispose }
}

/** Fetches and parses a splat PLY; a failure is thrown on render so the layer's boundary catches it. */
function useSplatData(url: string, maxSplats?: number): GaussianSplatData | null {
  const [state, setState] = useState<{ data: GaussianSplatData | null; error: Error | null }>({
    data: null,
    error: null,
  })
  useEffect(() => {
    const abort = new AbortController()
    setState({ data: null, error: null })
    void (async () => {
      try {
        const response = await fetch(rewriteLoopbackAssetUrl(url), {
          credentials: 'same-origin',
          signal: abort.signal,
        })
        if (!response.ok) throw new Error(`Could not load the splat (${response.status}).`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const data = parseGaussianSplatPly(bytes, { maxSplats })
        if (!abort.signal.aborted) setState({ data, error: null })
      } catch (cause) {
        if (abort.signal.aborted) return
        setState({
          data: null,
          error: cause instanceof Error ? cause : new Error('Could not load the splat.'),
        })
      }
    })()
    return () => abort.abort()
  }, [url, maxSplats])
  if (state.error) throw state.error
  return state.data
}

export function CaptureSplatLayer({
  artifactUrl,
  maxSplats,
  opacity = 1,
}: {
  artifactUrl: string | null
  maxSplats?: number
  /** 0 to 1. */
  opacity?: number
}) {
  if (!artifactUrl) return null
  return <LoadedSplat maxSplats={maxSplats} opacity={opacity} url={artifactUrl} />
}

function LoadedSplat({
  maxSplats,
  opacity,
  url,
}: {
  maxSplats?: number
  opacity: number
  url: string
}) {
  const data = useSplatData(url, maxSplats)
  const invalidate = useThree((state) => state.invalidate)
  const built = useMemo(() => {
    if (!data) return null
    const objects = createSplatObjects(data, buildSplatTextures(data))
    return { ...objects, scratch: createSortScratch(data.count), positions: data.positions }
  }, [data])
  useEffect(() => () => built?.dispose(), [built])
  useEffect(() => {
    if (!built) return
    built.opacityUniform.value = Math.min(1, Math.max(0, opacity))
    invalidate()
  }, [built, invalidate, opacity])

  const last = useRef({ forward: new Vector3(), origin: new Vector3(), time: 0, valid: false })
  const scratch = useRef({
    inverse: new Matrix4(),
    forward: new Vector3(),
    origin: new Vector3(),
  })
  useFrame(({ camera }) => {
    if (!built) return
    built.mesh.updateWorldMatrix(true, false)
    const { inverse, forward, origin } = scratch.current
    inverse.copy(built.mesh.matrixWorld).invert()
    origin.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse)
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(inverse)
    const state = last.current
    const now = performance.now()
    const moved =
      !state.valid ||
      forward.dot(state.forward) <= RESORT_DOT ||
      origin.distanceTo(state.origin) >= RESORT_DISTANCE
    if (!moved) return
    if (now - state.time < RESORT_MILLIS) {
      // Sorting is throttled; ask for another frame so a view that stops moving still gets sorted.
      invalidate()
      return
    }
    sortSplatsBackToFront(
      built.positions,
      built.order.length,
      [origin.x, origin.y, origin.z],
      [forward.x, forward.y, forward.z],
      built.order,
      built.scratch,
    )
    built.orderAttribute.needsUpdate = true
    state.forward.copy(forward)
    state.origin.copy(origin)
    state.time = now
    state.valid = true
    // The frame that sorted drew the previous order; draw once more with the new one.
    invalidate()
  })

  return built ? <primitive object={built.mesh} /> : null
}
