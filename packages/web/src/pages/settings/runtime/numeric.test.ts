import { expect, it } from 'vitest'
import { invalidNumber, optionalNumber } from './numeric'
it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992'])('整数配置拒绝 %s', (s) => expect(invalidNumber(s, 'integer')).toBe(true))
it.each(['1', '128000', '1536', ''])('整数配置接受 %s（空表示未配置）', (s) => expect(invalidNumber(s, 'integer')).toBe(false))
it.each(['Infinity', '-0.1', 'NaN'])('价格拒绝 %s', (s) => expect(invalidNumber(s, 'price')).toBe(true))
it.each(['0', '0.25', '2', ''])('价格接受 %s', (s) => expect(invalidNumber(s, 'price')).toBe(false))
it('空与零不混淆', () => { expect(optionalNumber(' ')).toBeUndefined(); expect(optionalNumber('0')).toBe(0) })
