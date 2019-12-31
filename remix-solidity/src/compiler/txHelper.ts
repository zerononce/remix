'use strict'

import { CompilationResult, visitContractsCallbackParam, visitContractsCallbackInterface } from './types'
export default {

  /**
    * return the contract obj of the given @arg name. Uses last compilation result.
    * return null if not found
    * @param name - contract name
    * @param contracts - 'contracts' object from last compilation result
    * @returns contract obj and associated file: { contract, file } or null
    */
  getContract: (contractName: string, contracts: CompilationResult["contracts"]) : Record<string, any> | null => {
    for (const file in contracts) {
      if (contracts[file][contractName]) {
        return { object: contracts[file][contractName], file: file }
      }
    }
    return null
  },

  /**
    * call the given @arg cb (function) for all the contracts. Uses last compilation result
    * stop visiting when cb return true
    * @param contracts - 'contracts' object from last compilation result
    * @param cb    - callback
    */
  visitContracts: (contracts: CompilationResult["contracts"], cb: visitContractsCallbackInterface) : void=> {
    for (const file in contracts) {
      for (const name in contracts[file]) {
        const param: visitContractsCallbackParam = { 
          name: name, 
          object: contracts[file][name], 
          file: file 
        }
        if (cb(param)) return
      }
    }
  }

}
