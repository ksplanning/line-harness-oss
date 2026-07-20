import { describe, expect, test, vi } from 'vitest';
import { createPostalLookupService } from './postal-lookup.js';

const ZIPCLOUD_ADDRESS_RESPONSE = {
  message: null,
  results: [
    {
      address1: '大阪府',
      address2: '高槻市',
      address3: '',
      kana1: 'ｵｵｻｶﾌ',
      kana2: 'ﾀｶﾂｷｼ',
      kana3: '',
      prefcode: '27',
      zipcode: '5690000',
    },
  ],
  status: 200,
};

describe('postal lookup service', () => {
  test('実在する郵便番号を pref / city / town に変換する', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => Response.json(ZIPCLOUD_ADDRESS_RESPONSE),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('5690000')).resolves.toEqual({
      pref: '大阪府',
      city: '高槻市',
      town: '',
    });
  });

  test('存在しない郵便番号は null を返す', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ message: null, results: null, status: 200 }),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('0000000')).resolves.toBeNull();
  });

  test('7桁でない形式は upstream を呼ばず拒否する', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('569-00a0')).rejects.toThrow('Postal code must be 7 digits');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('upstream の通信失敗を構造化エラーへ変換する', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('5690000')).rejects.toMatchObject({
      name: 'PostalLookupUpstreamError',
      message: 'Postal lookup upstream unavailable',
    });
  });

  test('upstream の非 2xx 応答を構造化エラーへ変換する', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ message: 'maintenance', results: null, status: 500 }, { status: 503 }),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('5690000')).rejects.toMatchObject({
      name: 'PostalLookupUpstreamError',
    });
  });

  test('upstream の不正な JSON shape を拒否する', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        message: null,
        results: [{ address1: '大阪府', address2: 42, address3: '' }],
        status: 200,
      }),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('5690000')).rejects.toMatchObject({
      name: 'PostalLookupUpstreamError',
    });
  });

  test('異なる住所候補が複数ある郵便番号は誤った町域を選ばない', async () => {
    const first = ZIPCLOUD_ADDRESS_RESPONSE.results[0];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        message: null,
        results: [
          { ...first, zipcode: '0790177', address1: '北海道', address2: '美唄市', address3: '上美唄町協和' },
          { ...first, zipcode: '0790177', address1: '北海道', address2: '美唄市', address3: '上美唄町南' },
        ],
        status: 200,
      }),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('0790177')).rejects.toMatchObject({
      name: 'PostalLookupAmbiguousError',
    });
  });

  test('2件目以降の候補も JSON shape を検証する', async () => {
    const first = ZIPCLOUD_ADDRESS_RESPONSE.results[0];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        message: null,
        results: [first, { ...first, address2: 42 }],
        status: 200,
      }),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    await expect(lookup('5690000')).rejects.toMatchObject({
      name: 'PostalLookupUpstreamError',
    });
  });

  test('同じ郵便番号の正常結果を再利用して upstream 呼出しを減らす', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => Response.json(ZIPCLOUD_ADDRESS_RESPONSE),
    );
    const lookup = createPostalLookupService({ fetchImpl });

    const first = await lookup('5690000');
    const second = await lookup('5690000');

    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('正常結果は1時間後に再取得する', async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => Response.json(ZIPCLOUD_ADDRESS_RESPONSE),
    );
    const lookup = createPostalLookupService({ fetchImpl, now: () => now });

    await lookup('5690000');
    now = 60 * 60 * 1_000 + 1;
    await lookup('5690000');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('未存在結果は5分後に再取得する', async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () => Response.json({ message: null, results: null, status: 200 }),
    );
    const lookup = createPostalLookupService({ fetchImpl, now: () => now });

    await lookup('0000000');
    now = 5 * 60 * 1_000 + 1;
    await lookup('0000000');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
