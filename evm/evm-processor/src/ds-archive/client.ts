import {addErrorContext, maybeLast, withErrorContext} from '@subsquid/util-internal'
import {HttpClient} from '@subsquid/util-internal-http-client'
import {ArchiveDataSource, BatchRequest, BatchResponse} from '@subsquid/util-internal-processor-tools'
import assert from 'assert'
import {DataRequest, DEFAULT_FIELDS, Fields, FullBlockData, FullLogItem} from '../interfaces/data'
import {EvmBlock, EvmLog, EvmTransaction} from '../interfaces/evm'
import {blockItemOrder, formatId} from '../util'
import * as gw from './gateway'


export class EvmArchive implements ArchiveDataSource<DataRequest, FullBlockData> {
    constructor(private http: HttpClient) {}

    async getFinalizedBatch(request: BatchRequest<DataRequest>): Promise<BatchResponse<FullBlockData>> {
        let q: gw.BatchRequest = {
            fromBlock: request.range.from,
            toBlock: request.range.to,
            includeAllBlocks: !!request.request.includeAllBlocks,
            transactions: [],
            logs: []
        }

        let fields = request.request.fields

        let fieldSelection = toFieldSelection(fields)

        request.request.transactions?.forEach(tx => {
            q.transactions.push({
                to: tx.to,
                from: tx.from,
                sighash: tx.sighash,
                fieldSelection: {...fieldSelection, log: undefined}
            })
        })

        request.request.logs?.forEach(log => {
            q.logs.push({
                address: log.address,
                topics: log.filter || [],
                fieldSelection: fields?.log?.transaction ? fieldSelection : {...fieldSelection, transaction: undefined}
            })
        })

        let res = await this.query(q)

        let lastBlock = res.nextBlock - 1

        let batch: BatchResponse<FullBlockData> = {
            range: {from: request.range.from, to: lastBlock},
            blocks: [],
            chainHeight: res.archiveHeight
        }

        for (let bb of res.data) {
            for (let block of bb) {
                batch.blocks.push(
                    tryMapGatewayBlock(block)
                )
            }
        }

        batch.blocks.sort((a, b) => a.header.height - b.header.height)

        if (maybeLast(batch.blocks)?.header.height !== batch.range.to) {
            // Always include last block of a batch range
            let lastBlockHeader = await this.fetchBlockHeader(batch.range.to, fieldSelection)
                .catch(withErrorContext({blockHeight: batch.range.to}))

            batch.blocks.push({
                header: lastBlockHeader,
                items: []
            })
        }

        return batch
    }

    private async fetchBlockHeader(height: number, fieldSelection: gw.FieldSelection): Promise<EvmBlock> {
        let res = await this.query({
            fromBlock: height,
            toBlock: height,
            includeAllBlocks: true,
            transactions: [{
                fieldSelection
            }],
            logs: []
        })
        assert(res.data.length == 1)
        assert(res.data[0].length == 1)
        return mapGatewayBlockHeader(res.data[0][0].block)
    }

    private query(q: gw.BatchRequest): Promise<gw.BatchResponse> {
        return this.http.post('/query', {json: q}).catch(withErrorContext({archiveQuery: q}))
    }

    async getFinalizedHeight(): Promise<number> {
        let {height}: {height: number} = await this.http.get('/height')
        return height
    }
}


function tryMapGatewayBlock(src: gw.BlockData): FullBlockData {
    try {
        return mapGatewayBlock(src)
    } catch (e: any) {
        throw addErrorContext(e, {
            blockHeight: src.block.number,
            blockHash: src.block.hash,
        })
    }
}


function mapGatewayBlock(src: gw.BlockData): FullBlockData {
    let header = mapGatewayBlockHeader(src.block)

    let items: FullBlockData['items'] = []
    let txIndex = new Map<EvmTransaction['index'], EvmTransaction>()

    for (let gtx of src.transactions) {
        let transaction = mapGatewayTransaction(header.height, header.hash, gtx)
        items.push({kind: 'transaction', transaction})
        txIndex.set(transaction.index, transaction)
    }

    for (let gl of src.logs) {
        let log = mapGatewayLog(header.height, header.hash, gl)
        let item: Partial<FullLogItem> = {kind: 'log', log}
        let transaction = txIndex.get(log.transactionIndex)
        if (transaction) {
            item.transaction = transaction
        }
        items.push(item as FullLogItem)
    }

    items.sort(blockItemOrder)

    return {header, items}
}


function mapGatewayBlockHeader(src: gw.Block): EvmBlock {
    let header: Partial<EvmBlock> = {
        id: formatId(src.number, src.hash),
        height: src.number,
        hash: src.hash
    }

    let key: keyof gw.Block
    for (key in src) {
        switch(key) {
            case 'number':
            case 'hash':
                break
            case 'timestamp':
                header.timestamp = Number(src.timestamp)
                break
            case 'nonce':
            case 'difficulty':
            case 'totalDifficulty':
            case 'size':
            case 'gasUsed':
            case 'gasLimit':
            case 'baseFeePerGas':
                header[key] = BigInt(src[key]!)
                break
            default:
                header[key] = src[key]
        }
    }

    return header as EvmBlock
}


function mapGatewayTransaction(blockHeight: number, blockHash: string, src: gw.Transaction): EvmTransaction {
    let tx: Partial<EvmTransaction> = {
        id: formatId(blockHeight, blockHash, src.index)
    }

    let key: keyof gw.Transaction
    for (key in src) {
        switch(key) {
            case 'from':
            case 'to':
            case 'hash':
            case 'input':
            case 'r':
            case 's':
                tx[key] = src[key]
                break
            case 'gas':
            case 'gasPrice':
            case 'nonce':
            case 'value':
            case 'v':
            case 'maxFeePerGas':
            case 'maxPriorityFeePerGas':
                tx[key] = BigInt(src[key]!)
                break
            case 'index':
            case 'chainId':
            case 'yParity':
                tx[key] = src[key]
                break
        }
    }

    return tx as EvmTransaction
}


function mapGatewayLog(blockHeight: number, blockHash: string, src: gw.Log): EvmLog {
    let log: Partial<EvmLog> = {
        id: formatId(blockHeight, blockHash, src.index),
        index: src.index
    }

    let key: keyof gw.Log
    for (key in src) {
        switch(key) {
            case 'transactionHash':
            case 'address':
            case 'data':
                log[key] = src[key]
                break
            case 'topics':
                log.topics = src.topics
                break
            case 'transactionIndex':
                log.transactionIndex = src.transactionIndex
                break
        }
    }

    return log as EvmLog
}


function toFieldSelection(fields?: Fields): gw.FieldSelection {
    let {transaction, ...logFields} = fields?.log || {}
    return  {
        block: {
            ...mergeDefaultFields(DEFAULT_FIELDS.block, fields?.block),
            hash: true,
            number: true
        },
        transaction: {
            ...mergeDefaultFields(DEFAULT_FIELDS.transaction, fields?.transaction),
            index: true
        },
        log: {
            ...mergeDefaultFields(DEFAULT_FIELDS.log, logFields),
            index: true,
            transactionIndex: true
        }
    }
}


type Selector<Props extends string> = {
    [K in Props]?: boolean
}


function mergeDefaultFields<P extends string>(defaults: Selector<P>, selection?: Selector<P>): Selector<P> {
    let result: Selector<P> = {...defaults}
    for (let key in selection) {
        if (selection[key] != null) {
            if (selection[key]) {
                result[key] = true
            } else {
                result[key] = undefined
            }
        }
    }
    return result
}