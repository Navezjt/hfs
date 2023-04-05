// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import {
    getNodeName,
    hasPermission,
    nodeIsDirectory,
    statusCodeForMissingPerm,
    urlToNode,
    VfsNode, VfsPerm,
    walkNode, WHO_NO_ONE
} from './vfs'
import { ApiError, ApiHandler, SendListReadable } from './apiMiddleware'
import { stat } from 'fs/promises'
import { mapPlugins } from './plugins'
import { asyncGeneratorToArray, dirTraversal, pattern2filter } from './misc'
import _ from 'lodash'
import { HTTP_BAD_REQUEST, HTTP_FOOL, HTTP_METHOD_NOT_ALLOWED, HTTP_NOT_FOUND } from './const'
import Koa from 'koa'

export const file_list: ApiHandler = async ({ path, offset, limit, search, omit, sse }, ctx) => {
    let node = await urlToNode(path || '/', ctx)
    const list = new SendListReadable()
    if (!node)
        return fail(HTTP_NOT_FOUND)
    const res = statusCodeForMissingPerm(node,'can_list',ctx)
    if (res)
        return fail(res)
    if (dirTraversal(search))
        return fail(HTTP_FOOL)
    if (node.default)
        return (sse ? list.custom : _.identity)({ // sse will wrap the object in a 'custom' message, otherwise we plainly return the object
            redirect: path // tell the browser to access the folder (instead of using this api), so it will get the default file
        })
    if (!await nodeIsDirectory(node))
        return fail(HTTP_METHOD_NOT_ALLOWED)
    offset = Number(offset)
    limit = Number(limit)
    const filter = pattern2filter(search)
    const walker = walkNode(node, ctx, search ? Infinity : 0)
    const onDirEntryHandlers = mapPlugins(plug => plug.onDirEntry)
    const can_upload = hasPermission(node, 'can_upload', ctx)
    const can_delete = hasPermission(node, 'can_delete', ctx)
    const props = { can_upload, can_delete, accept: node.accept }
    if (!sse)
        return { ...props, list: await asyncGeneratorToArray(produceEntries()) }
    setTimeout(async () => {
        if (can_upload || can_delete)
            list.custom({ props })
        for await (const entry of produceEntries())
            list.add(entry)
        list.close()
    })
    return list

    function fail(code: any) {
        if (!sse)
            return new ApiError(code)
        list.error(code, true)
        return list
    }

    async function* produceEntries() {
        for await (const sub of walker) {
            if (ctx.aborted) break
            if (!filter(getNodeName(sub)))
                continue
            const entry = await nodeToDirEntry(ctx, sub)
            if (!entry)
                continue
            const cbParams = { entry, ctx, listPath:path, node:sub }
            try {
                if (onDirEntryHandlers.some(cb => cb(cbParams) === false))
                    continue
            }
            catch(e) {
                console.log("a plugin with onDirEntry is causing problems:", e)
            }
            if (offset) {
                --offset
                continue
            }
            if (omit) {
                if (omit !== 'c')
                    ctx.throw(HTTP_BAD_REQUEST, 'omit')
                if (!entry.m)
                    entry.m = entry.c
                delete entry.c
            }
            yield entry
            if (limit && !--limit)
                break
        }
    }
}

export interface DirEntry { n:string, s?:number, m?:Date, c?:Date, p?: string }

async function nodeToDirEntry(ctx: Koa.Context, node: VfsNode): Promise<DirEntry | null> {
    let { source, default:def } = node
    const name = getNodeName(node)
    if (!source)
        return name ? { n: name + '/' } : null
    if (def)
        return { n: name }
    try {
        const st = await stat(source)
        const folder = st.isDirectory()
        const { ctime, mtime } = st
        return {
            n: name + (folder ? '/' : ''),
            c: ctime,
            m: Math.abs(+mtime-+ctime) < 1000 ? undefined : mtime,
            s: folder ? undefined : st.size,
            p: (['can_read', 'can_list'] as (keyof VfsPerm)[]).map(perm2letter).join('')
                || undefined
        }
    }
    catch {
        return null
    }

    function perm2letter(k: keyof VfsPerm) {
        return node[k] === WHO_NO_ONE ? k[4]!
            : hasPermission(node, k, ctx) ? ''
                :  k[4]!.toUpperCase()
    }
}
