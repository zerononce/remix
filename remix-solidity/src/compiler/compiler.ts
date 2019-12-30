'use strict'

var solc = require('solc/wrapper')
var solcABI = require('solc/abi')
var webworkify = require('webworkify')
var compilerInput = require('./compiler-input')
var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager
var txHelper = require('./txHelper')

/*
  trigger compilationFinished, compilerLoaded, compilationStarted, compilationDuration
*/
export class Compiler {
  event: any
  state: any
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

  setOptimize (_optimize) {
    this.state.optimize = _optimize
  }

  setEvmVersion (_evmVersion) {
    this.state.evmVersion = _evmVersion
  }

  setLanguage (_language) {
    this.state.language = _language
  }

  internalCompile (files, target?, missingInputs?) {
    this.gatherImports(files, target, missingInputs, (error, input) => {
      if (error) {
        this.state.lastCompilationResult = null
        this.event.trigger('compilationFinished', [false, {'error': { formattedMessage: error, severity: 'error' }}, files])
      } else {
        this.state.compileJSON(input)
      }
    })
  }

  compile (files, target) {
    this.event.trigger('compilationStarted', [])
    this.internalCompile(files, target)
  }

  setCompileJSON (_compileJSON) {
    this.state.compileJSON = _compileJSON
  }

  onCompilerLoaded (version) {
    this.state.currentVersion = version
    this.event.trigger('compilerLoaded', [version])
  }

  onInternalCompilerLoaded () {
    if (this.state.worker === null) {
      var compiler
      if (typeof (window) === 'undefined') {
        compiler = require('solc')
      } else {
        compiler = solc(window['Module'])
      }

      this.state.compileJSON = (source) => {
        var missingInputs: any = []
        var missingInputsCallback = (path) => {
          missingInputs.push(path)
          return { error: 'Deferred import' }
        }

        var result
        try {
          var input = compilerInput(source.sources, {optimize: this.state.optimize, evmVersion: this.state.evmVersion, language: this.state.language, target: source.target})
          result = compiler.compile(input, { import: missingInputsCallback })
          result = JSON.parse(result)
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
  getContract (name) {
    if (this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return txHelper.getContract(name, this.state.lastCompilationResult.data.contracts)
    }
    return null
  }

  /**
    * call the given @arg cb (function) for all the contracts. Uses last compilation result
    * @param {Function} cb    - callback
    */
  visitContracts (cb) {
    if (this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return txHelper.visitContracts(this.state.lastCompilationResult.data.contracts, cb)
    }
    return null
  }

  /**
    * return the compiled contracts from the last compilation result
    * @return {Object}     - contracts
    */
  getContracts () {
    if (this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.contracts) {
      return this.state.lastCompilationResult.data.contracts
    }
    return null
  }

   /**
    * return the sources from the last compilation result
    * @param {Object} cb    - map of sources
    */
  getSources (){
    if (this.state.lastCompilationResult.source) {
      return this.state.lastCompilationResult.source.sources
    }
    return null
  }

  /**
    * return the sources @arg fileName from the last compilation result
    * @param {Object} cb    - map of sources
    */
  getSource (fileName) {
    if (this.state.lastCompilationResult.source) {
      return this.state.lastCompilationResult.source.sources[fileName]
    }
    return null
  }

  /**
    * return the source from the last compilation result that has the given index. null if source not found
    * @param {Int} index    - index of the source
    */
  getSourceName = (index) => {
    if (this.state.lastCompilationResult.data && this.state.lastCompilationResult.data.sources) {
      return Object.keys(this.state.lastCompilationResult.data.sources)[index]
    }
    return null
  }

  compilationFinished (data, missingInputs?, source?) {
    var noFatalErrors = true // ie warnings are ok

    var isValidError = (error) => {
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
    } else if (missingInputs !== undefined && missingInputs.length > 0) {
      // try compiling again with the new set of inputs

      this.internalCompile(source.sources, source.target, missingInputs)
    } else {
      data = this.updateInterface(data)

      this.state.lastCompilationResult = {
        data: data,
        source: source
      }
      this.event.trigger('compilationFinished', [true, data, source])
    }
  }

  // TODO: needs to be changed to be more node friendly
  loadVersion (usingWorker, url) {
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

  loadInternal (url) {
    delete window['Module']
    // NOTE: workaround some browsers?
    window['Module'] = undefined

    // Set a safe fallback until the new one is loaded
    this.setCompileJSON((source) => {
      this.compilationFinished({ error: { formattedMessage: 'Compiler not yet loaded.' } })
    })

    var newScript = document.createElement('script')
    newScript.type = 'text/javascript'
    newScript.src = url
    document.getElementsByTagName('head')[0].appendChild(newScript)
    var check = window.setInterval(() => {
      if (!window['Module']) {
        return
      }
      window.clearInterval(check)
      this.onInternalCompilerLoaded()
    }, 200)
  }

  loadWorker (url) {
    this.state.worker = webworkify(require('./compiler-worker.js'))
    var jobs: any = []
    this.state.worker.addEventListener('message',(msg) => {
      var data = msg.data
      switch (data.cmd) {
        case 'versionLoaded':
          this.onCompilerLoaded(data.data)
          break
        case 'compiled':
          var result
          try {
            result = JSON.parse(data.data)
          } catch (exception) {
            result = { 'error': 'Invalid JSON output from the compiler: ' + exception }
          }
          var sources = {}
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
    this.state.compileJSON = (source) => {
      jobs.push({sources: source})
      this.state.worker.postMessage({cmd: 'compile', job: jobs.length - 1, input: compilerInput(source.sources,
        {optimize: this.state.optimize, evmVersion: this.state.evmVersion, language: this.state.language, target: source.target})})
    }
    this.state.worker.postMessage({cmd: 'loadVersion', data: url})
  }

  gatherImports (files, target, importHints, cb) {
    importHints = importHints || []

    // FIXME: This will only match imports if the file begins with one.
    //        It should tokenize by lines and check each.
    // eslint-disable-next-line no-useless-escape
    var importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g

    for (var fileName in files) {
      var match
      while ((match = importRegex.exec(files[fileName].content))) {
        var importFilePath = match[1]
        if (importFilePath.startsWith('./')) {
          var path = /(.*\/).*/.exec(fileName)
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
      var m = importHints.pop()
      if (m in files) {
        continue
      }

      if (this.handleImportCall) {
        this.handleImportCall(m, (err, content) => {
          if (err) {
            cb(err)
          } else {
            files[m] = { content }
            this.gatherImports(files, target, importHints, cb)
          }
        })
      }

      return
    }

    cb(null, { 'sources': files, 'target': target })
  }

  truncateVersion (version) {
    var tmp = /^(\d+.\d+.\d+)/.exec(version)
    if (tmp) {
      return tmp[1]
    }
    return version
  }
  
  updateInterface (data) {
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
      data.contracts[contract.file][contract.name].abi = solcABI.update(this.truncateVersion(this.state.currentVersion), contract.object.abi)
    })
    return data
  }
}

