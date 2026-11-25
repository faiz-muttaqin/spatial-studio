import { describe, expect, test } from 'bun:test'
import {
  buildSplatTextures,
  createSortScratch,
  SPLAT_TEXTURE_WIDTH,
  sortSplatsBackToFront,
  splatCovariance,
} from './splat-data'

describe('splatCovariance', () => {
  test('an axis-aligned splat has its squared scales on the diagonal', () => {
    const [xx, xy, xz, yy, yz, zz] = splatCovariance([0.1, 0.2, 0.3], [1, 0, 0, 0])
    expect([xx, yy, zz].map((value) => Number(value.toFixed(6)))).toEqual([0.01, 0.04, 0.09])
    expect([xy, xz, yz].every((value) => Math.abs(value) < 1e-12)).toBe(true)
  })

  test('a quarter turn about Z swaps the X and Y variances', () => {
    const half = Math.SQRT1_2
    const [xx, , , yy] = splatCovariance([0.1, 0.2, 0.3], [half, 0, 0, half])
    expect(xx).toBeCloseTo(0.04)
    expect(yy).toBeCloseTo(0.01)
  })
})

describe('sortSplatsBackToFront', () => {
  test('orders splats from the farthest to the nearest along the view direction', () => {
    const positions = new Float32Array([0, 0, -1, 0, 0, -5, 0, 0, -3, 0, 0, -2])
    const order = new Float32Array(4)
    sortSplatsBackToFront(positions, 4, [0, 0, 0], [0, 0, -1], order, createSortScratch(4))
    expect([...order]).toEqual([1, 2, 3, 0])
  })

  test('a different view direction gives the opposite order', () => {
    const positions = new Float32Array([0, 0, -1, 0, 0, -5])
    const order = new Float32Array(2)
    sortSplatsBackToFront(positions, 2, [0, 0, 0], [0, 0, 1], order, createSortScratch(2))
    expect([...order]).toEqual([0, 1])
  })
})

describe('buildSplatTextures', () => {
  test('packs one texel per splat into the four textures', () => {
    const textures = buildSplatTextures({
      count: 1,
      sourceCount: 1,
      positions: new Float32Array([1, 2, 3]),
      colors: new Float32Array([1, 0.5, 0]),
      opacities: new Float32Array([0.25]),
      scales: new Float32Array([0.1, 0.1, 0.1]),
      rotations: new Float32Array([1, 0, 0, 0]),
    })
    expect(textures.width).toBe(SPLAT_TEXTURE_WIDTH)
    expect(textures.height).toBe(1)
    expect([...textures.centres.slice(0, 4)]).toEqual([1, 2, 3, 0.25])
    expect([...textures.colours.slice(0, 4)]).toEqual([255, 128, 0, 255])
    expect(textures.covarianceA[0]).toBeCloseTo(0.01)
    expect(textures.covarianceB[1]).toBeCloseTo(0.01)
  })
})
