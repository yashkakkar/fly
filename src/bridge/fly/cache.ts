import { registerBridge } from '../'
import { ivm } from '../../'
import log from '../../log'
import { transferInto } from '../../utils/buffer'
import { Bridge } from '../bridge';
import { Runtime } from '../../runtime';

const errCacheStoreUndefined = new Error("cacheStore is not defined in the config.")

registerBridge('flyCacheSet', function cacheSet(rt: Runtime, bridge: Bridge, key: string, value: ArrayBuffer | string, ttl: number, callback: ivm.Reference<Function>) {
  if (!bridge.cacheStore) {
    callback.applyIgnored(null, [errCacheStoreUndefined.toString()])
    return
  }

  let buf: Buffer
  try {
    if (value instanceof ArrayBuffer) {
      buf = Buffer.from(value)
    } else {
      // handle strings and garbage inputs reasonably
      buf = Buffer.from(value.toString(), "utf8")
    }
  } catch (err) {
    callback.applyIgnored(null, [err.toString()])
    return
  }
  bridge.cacheStore.set(rt, key, buf, ttl).then((ok) => {
    rt.reportUsage("cache:set", { size: buf.byteLength })
    callback.applyIgnored(null, [null, ok])
  }).catch((err) => {
    log.error(err)
    callback.applyIgnored(null, [err.toString()])
  })
  return
})

registerBridge('flyCacheExpire', function cacheExpire(rt: Runtime, bridge: Bridge, key: string, ttl: number, callback: ivm.Reference<Function>) {
  if (!bridge.cacheStore) {
    callback.applyIgnored(null, [errCacheStoreUndefined.toString()])
    return
  }

  bridge.cacheStore.expire(rt, key, ttl).then((ok) => {
    callback.applyIgnored(null, [null, ok])
  }).catch((err) => {
    callback.applyIgnored(null, [err.toString()])
  })
})

registerBridge('flyCacheGet',
  function cacheGet(rt: Runtime, bridge: Bridge, key: string, callback: ivm.Reference<Function>) {
    if (!bridge.cacheStore) {
      callback.applyIgnored(null, [errCacheStoreUndefined.toString()])
      return
    }

    bridge.cacheStore.get(rt, key).then((buf) => {
      rt.reportUsage("cache:get", { size: buf ? buf.byteLength : 0 })
      callback.applyIgnored(null, [null, transferInto(buf)])
    }).catch((err) => {
      log.error("got err in cache.get", err)
      callback.applyIgnored(null, [null, null]) // swallow errors on get for now
    })
  })