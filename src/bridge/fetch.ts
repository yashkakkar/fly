import { registerBridge } from './'

import { ivm } from '../'
import log from "../log"
import * as http from 'http'
import * as https from 'https'
import { parse as parseURL } from 'url'

import { Bridge } from './bridge';
import { Runtime } from '../runtime';
import { streamManager } from '../stream_manager';
import { isNumber } from 'util';

const fetchAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5 * 1000,
  maxSockets: 64, // seems sensible, this is per origin
  maxFreeSockets: 64
});
const fetchHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 5 * 1000,
  rejectUnauthorized: false, // for simplicity
  maxSockets: 64,
  maxFreeSockets: 64
})

function makeResponse(status: number, statusText: string, url: string, headers?: any) {
  return {
    status: status,
    statusText: statusText,
    ok: (status >= 200 && status < 300),
    url: url,
    headers: headers || {}
  }
}
registerBridge('fetch', function fetchBridge(rt: Runtime, bridge: Bridge, urlStr: string, init: any, body: ArrayBuffer | null | string, cb: ivm.Reference<Function>) {
  log.debug("native fetch with url:", urlStr)
  init || (init = {})
  const u = parseURL(urlStr)

  if (u.protocol === 'file:') {
    if (!bridge.fileStore) {
      cb.applyIgnored(null, ["no file store configured, should not happen!"])
      return
    }

    if (init.method && init.method != 'GET') {
      cb.applyIgnored(null, [null,
        makeResponse(405, "Method Not Allowed", urlStr)
      ])
      return
    }

    try {
      bridge.fileStore.createReadStream(rt, urlStr.replace("file://", "")).then((stream) => {
        const id = streamManager.add(rt, stream)
        cb.applyIgnored(null, [null,
          new ivm.ExternalCopy(makeResponse(200, "OK", urlStr)).copyInto({ release: true }),
          id
        ])
      }).catch((err) => {
        cb.applyIgnored(null, [null,
          new ivm.ExternalCopy(makeResponse(404, "Not Found", urlStr)).copyInto({ release: true }),
          ""
        ])
      })
    } catch (e) {
      // Might throw FileNotFound
      cb.applyIgnored(null, [null,
        new ivm.ExternalCopy(makeResponse(404, "Not Found", urlStr)).copyInto({ release: true }),
        ""
      ])
    }
    return
  }

  const httpFn = u.protocol == 'http:' ? http.request : https.request
  const httpAgent = u.protocol == 'http:' ? fetchAgent : fetchHttpsAgent

  let method = init.method || "GET"
  let headers = init.headers || {}

  let req: http.ClientRequest;

  let path = u.pathname
  if (u.query != null) {
    path = path + "?" + u.query
  }
  let timeout: NodeJS.Timer | undefined
  if (init.timeout && isNumber(init.timeout) && init.timeout > 0) {
    timeout = setTimeout(handleTimeout, init.timeout)
  }
  const reqOptions: https.RequestOptions = {
    agent: httpAgent,
    protocol: u.protocol,
    path: path,
    hostname: u.hostname,
    host: u.host,
    port: u.port,
    method: method,
    headers: headers,
    timeout: 60 * 1000
  }
  //console.log(reqOptions)
  if (httpFn == https.request) {
    reqOptions.servername = reqOptions.hostname
  }
  req = httpFn(reqOptions)
  req.setNoDelay(true)

  req.setHeader('fly-app', rt.app.name)

  req.once("error", handleError)
  req.once("timeout", handleError)
  req.once("response", handleResponse)

  const start = process.hrtime()
  const dataOut = body ? Buffer.byteLength(body) : 0

  setImmediate(function () {
    if (body instanceof ArrayBuffer) {
      req.end(Buffer.from(body))
    } else {
      req.end(!!body ? body : null)
    }
  })

  return

  function clearFetchTimeout() {
    if (timeout) {
      clearInterval(timeout)
    }
  }
  function handleResponse(res: http.IncomingMessage) {
    clearFetchTimeout()
    rt.reportUsage("fetch", {
      data_out: dataOut,
      method: method,
      host: u.host,
      path: u.path,
      remote_addr: res.socket.remoteAddress,
      status: res.statusCode,
      response_time: process.hrtime(start)
    })

    req.removeAllListeners()

    const retInit = new ivm.ExternalCopy({
      status: res.statusCode,
      statusText: res.statusMessage,
      ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 400,
      url: urlStr,
      headers: res.headers
    }).copyInto({ release: true })

    if (res.method === 'GET' || res.method === 'HEAD') {
      return cb.applyIgnored(null, [null, retInit])
    }

    cb.applyIgnored(null, [null, retInit, streamManager.add(rt, res, { readTimeout: init.readTimeout })])
  }

  function handleError(err: Error) {
    clearFetchTimeout()
    log.error("error requesting http resource", err)
    cb.applyIgnored(null, [err.toString()])
    req.removeAllListeners()
    try { req.end(); req.socket.destroy() } catch (e) { }
  }

  function handleTimeout() {
    handleError(new Error("http request timeout"))
  }
})