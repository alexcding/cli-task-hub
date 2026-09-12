// A same-origin worker avoids opaque data-URL origins under WebKit's CSP.
self.MonacoEnvironment = { baseUrl: self.location.origin + '/vendor/monaco/' };
importScripts('/vendor/monaco/vs/base/worker/workerMain.js');
