'use strict'

var solc = require('solc/wrapper')
var solcABI = require('solc/abi')
var webworkify = require('webworkify')
import compilerInput from './compiler-input'
var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager
var txHelper = require('./txHelper')
import { Source, SourceWithTarget, EVMVersion, Language, State, CompilationResult } from './types'

/*
  trigger compilationFinished, compilerLoaded, compilationStarted, compilationDuration
*/
export class Compiler {
  event: any
  state: State
  handleImportCall: any

  constructor (handleImportCall) {
    this.event = new EventManager()
    this.state = {
      compileJSON: null,
      worker: null,
      currentVersion: null,
      optimize: false,
      evmVersion: null,
      language: 'Solidity',
      compilationStartTime: null,
      target: null,
      lastCompilationResult: {
        data: null,
        source: null
      }
    }
    this.handleImportCall = handleImportCall

    this.event.register('compilationFinished', (success, data, source) => {
      if (success && this.state.compilationStartTime) {
        this.event.trigger('compilationDuration', [(new Date().getTime()) - this.state.compilationStartTime])
      }
      this.state.compilationStartTime = null
    })
  
    this.event.register('compilationStarted', () => {
      this.state.compilationStartTime = new Date().getTime()
    })
  }

  setOptimize (_optimize: boolean) {
    this.state.optimize = _optimize
  }

  setEvmVersion (_evmVersion: EVMVersion) {
    this.state.evmVersion = _evmVersion
  }

  setLanguage (_language: Language) {
    this.state.language = _language
  }

  internalCompile (files: Source, missingInputs?: any[]) {
    this.gatherImports(files, missingInputs, (error, input) => {
      if (error) {
        this.state.lastCompilationResult = null
        this.event.trigger('compilationFinished', [false, {'error': { formattedMessage: error, severity: 'error' }}, files])
      } else {
        this.state.compileJSON(input)
      }
    })
  }

  compile (files: Source, target: string) {
    this.state.target = target
    this.event.trigger('compilationStarted', [])
    this.internalCompile(files)
  }

  setCompileJSON (_compileJSON) {
    this.state.compileJSON = _compileJSON
  }

  onCompilerLoaded (version: string) {
    this.state.currentVersion = version
    this.event.trigger('compilerLoaded', [version])
  }

  onInternalCompilerLoaded () {
    if (this.state.worker === null) {
      let compiler
      if (typeof (window) === 'undefined') {
        compiler = require('solc')
      } else {
        compiler = solc(window['Module'])
      }

      this.state.compileJSON = (source: SourceWithTarget) => {
        let missingInputs: any = []
        let missingInputsCallback = (path) => {
          missingInputs.push(path)
          return { error: 'Deferred import' }
        }

        let result
        try {
          if(source && source.sources) {
            let input = compilerInput(source.sources, {optimize: this.state.optimize, evmVersion: this.state.evmVersion, language: this.state.language})
            result = compiler.compile(input, { import: missingInputsCallback })
            result = JSON.parse(result)
          }
        } catch (exception) {
          result = { error: { formattedMessage: 'Uncaught JavaScript exception:\n' + exception, severity: 'error', mode: 'panic' } }
        }
        this.compilationFinished(result, missingInputs, source)
      }
      this.onCompilerLoaded(compiler.version())
    }
  }
 
  /**
    * return the contract obj of the given @arg name. Uses last compilation result.
    * return null if not found
    * @param {String} name    - contract name
    * @returns contract obj and associated file: { contract, file } or null
    */
  getContract (name: string) {
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return txHelper.getContract(name, this.state.lastCompilationResult.data.contracts)
    }
    return null
  }

  /**
    * call the given @arg cb (function) for all the contracts. Uses last compilation result
    * @param {Function} cb    - callback
    */
  visitContracts (cb: any) {
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return txHelper.visitContracts(this.state.lastCompilationResult.data.contracts, cb)
    }
    return null
  }

  /**
    * return the compiled contracts from the last compilation result
    * @return {Object}     - contracts
    */
  getContracts () {
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return this.state.lastCompilationResult.data.contracts
    }
    return null
  }

   /**
    * return the sources from the last compilation result
    * @param {Object} cb    - map of sources
    */
  getSources (){
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.source) {
      return this.state.lastCompilationResult.source.sources
    }
    return null
  }

  /**
    * return the sources @arg fileName from the last compilation result
    * @param {Object} cb    - map of sources
    */
  getSource (fileName: string) {
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.source && this.state.lastCompilationResult.source.sources) {
      return this.state.lastCompilationResult.source.sources[fileName]
    }
    return null
  }

  /**
    * return the source from the last compilation result that has the given index. null if source not found
    * @param {Int} index    - index of the source
    */
  getSourceName (index: number) {
    if (this.state.lastCompilationResult && this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.sources) {
      return Object.keys(this.state.lastCompilationResult.data.sources)[index]
    }
    return null
  }

  compilationFinished (data: CompilationResult, missingInputs?: any[], source?: SourceWithTarget) {
    let noFatalErrors: boolean = true // ie warnings are ok

    let isValidError = (error) => {
      // The deferred import is not a real error
      // FIXME: maybe have a better check?
      if (/Deferred import/.exec(error.message)) {
        return false
      }

      return error.severity !== 'warning'
    }

    if (data['error'] !== undefined) {
      // Ignore warnings (and the 'Deferred import' error as those are generated by us as a workaround
      if (isValidError(data['error'])) {
        noFatalErrors = false
      }
    }
    if (data['errors'] !== undefined) {
      data['errors'].forEach((err) => {
        // Ignore warnings and the 'Deferred import' error as those are generated by us as a workaround
        if (isValidError(err)) {
          noFatalErrors = false
        }
      })
    }

    if (!noFatalErrors) {
      // There are fatal errors - abort here
      this.state.lastCompilationResult = null
      this.event.trigger('compilationFinished', [false, data, source])
    } else if (missingInputs && missingInputs.length > 0 && source && source.sources) {
      // try compiling again with the new set of inputs

      this.internalCompile(source.sources, missingInputs)
    } else {
      data = this.updateInterface(data)
      if(source)
      {
        this.state.lastCompilationResult = {
        data: data,
        source: source
        }
        source.target = this.state.target;
      }
      this.event.trigger('compilationFinished', [true, data, source])
    }
  }

  // TODO: needs to be changed to be more node friendly
  loadVersion (usingWorker: boolean, url: string) {
    console.log('Loading ' + url + ' ' + (usingWorker ? 'with worker' : 'without worker'))
    this.event.trigger('loadingCompiler', [url, usingWorker])

    if (this.state.worker !== null) {
      this.state.worker.terminate()
      this.state.worker = null
    }
    if (usingWorker) {
      this.loadWorker(url)
    } else {
      this.loadInternal(url)
    }
  }

  loadInternal (url: string) {
    delete window['Module']
    // NOTE: workaround some browsers?
    window['Module'] = undefined

    // Set a safe fallback until the new one is loaded
    this.setCompileJSON((source) => {
      this.compilationFinished({ error: { formattedMessage: 'Compiler not yet loaded.' } })
    })

    let newScript: any = document.createElement('script')
    newScript.type = 'text/javascript'
    newScript.src = url
    document.getElementsByTagName('head')[0].appendChild(newScript)
    let check: any = window.setInterval(() => {
      if (!window['Module']) {
        return
      }
      window.clearInterval(check)
      this.onInternalCompilerLoaded()
    }, 200)
  }

  loadWorker (url: string) {
    this.state.worker = webworkify(require('./compiler-worker.js'))
    let jobs: any = []
    this.state.worker.addEventListener('message', (msg) => {
      const data: any = msg.data
      switch (data.cmd) {
        case 'versionLoaded':
          this.onCompilerLoaded(data.data)
          break
        case 'compiled':
          let result: any
          try {
            result = JSON.parse(data.data)
          } catch (exception) {
            result = { 'error': 'Invalid JSON output from the compiler: ' + exception }
          }
          let sources: SourceWithTarget = {}
          if (data.job in jobs !== undefined) {
            sources = jobs[data.job]['sources']
            delete jobs[data.job]
          }
          this.compilationFinished(result, data.missingInputs, sources)
          break
      }
    })
    this.state.worker.addEventListener('error', (msg) => {
      this.compilationFinished({ error: 'Worker error: ' + msg.data })
    })
    this.state.compileJSON = (source: SourceWithTarget) => {
      if(source && source.sources) {
        jobs.push({sources: source})
        this.state.worker.postMessage({cmd: 'compile', job: jobs.length - 1, input: compilerInput(source.sources,
        {optimize: this.state.optimize, evmVersion: this.state.evmVersion, language: this.state.language})})
      }
    }
    this.state.worker.postMessage({cmd: 'loadVersion', data: url})
  }

  gatherImports (files: Source, importHints?: any[], cb?) {
    importHints = importHints || []

    // FIXME: This will only match imports if the file begins with one.
    //        It should tokenize by lines and check each.
    // eslint-disable-next-line no-useless-escape
    const importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g

    for (const fileName in files) {
      let match
      while ((match = importRegex.exec(files[fileName].content))) {
        let importFilePath = match[1]
        if (importFilePath.startsWith('./')) {
          const path = /(.*\/).*/.exec(fileName)
          if (path !== null) {
            importFilePath = importFilePath.replace('./', path[1])
          } else {
            importFilePath = importFilePath.slice(2)
          }
        }

        // FIXME: should be using includes or sets, but there's also browser compatibility..
        if (importHints.indexOf(importFilePath) === -1) {
          importHints.push(importFilePath)
        }
      }
    }

    while (importHints.length > 0) {
      const m = importHints.pop()
      if (m in files) {
        continue
      }

      if (this.handleImportCall) {
        this.handleImportCall(m, (err, content) => {
          if (err) {
            cb(err)
          } else {
            files[m] = { content }
            this.gatherImports(files, importHints, cb)
          }
        })
      }

      return
    }

    cb(null, { 'sources': files })
  }

  truncateVersion (version: string) {
    const tmp = /^(\d+.\d+.\d+)/.exec(version)
    if (tmp) {
      return tmp[1]
    }
    return version
  }
  
  updateInterface (data: CompilationResult) {
    txHelper.visitContracts(data.contracts, (contract) => {
      if (!contract.object.abi) contract.object.abi = []
      if (this.state.language === 'Yul' && contract.object.abi.length === 0) {
        // yul compiler does not return any abi,
        // we default to accept the fallback function (which expect raw data as argument).
        contract.object.abi.push({
          'payable': true,
          'stateMutability': 'payable',
          'type': 'fallback'
        })
      }
      if(data && data.contracts && this.state.currentVersion)
        data.contracts[contract.file][contract.name].abi = solcABI.update(this.truncateVersion(this.state.currentVersion), contract.object.abi)
    })
    return data
  }
}

