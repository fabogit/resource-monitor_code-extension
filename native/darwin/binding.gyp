{
  "targets": [
    {
      "target_name": "darwin_telemetry",
      "sources": [ "src/addon.cc" ],
      "conditions": [
        ['OS=="mac"', {
          "link_settings": {
            "libraries": [
              "-framework CoreFoundation",
              "-framework IOKit"
            ]
          },
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "CLANG_CXX_LIBRARY": "libc++",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
          }
        }]
      ]
    }
  ]
}
