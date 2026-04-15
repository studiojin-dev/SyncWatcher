import Foundation
import NetFS
import Security
import StoreKit
import Darwin

private struct SupporterStatusPayload: Encodable {
  let active: Bool
  let productId: String?
  let error: String?
}

private struct PurchasePayload: Encodable {
  let success: Bool
  let active: Bool
  let cancelled: Bool
  let pending: Bool
  let productId: String?
  let error: String?
}

private struct BookmarkCapturePayload: Encodable {
  let path: String
  let bookmark: String
  let error: String?
}

private struct BookmarkResolvePayload: Encodable {
  let path: String
  let stale: Bool
  let error: String?
}

private struct NetworkMountCapturePayload: Encodable {
  let scheme: String
  let remountUrl: String
  let username: String?
  let mountRootPath: String
  let relativePathFromMountRoot: String
  let error: String?
}

private struct NetworkMountRequestPayload: Decodable {
  let remountUrl: String
  let username: String?
  let password: String?
  let allowUi: Bool
}

private struct NetworkMountResultPayload: Encodable {
  let mountPath: String
  let errorKind: String?
  let error: String?
}

private struct KeychainSecretPayload: Decodable {
  let service: String
  let account: String
  let secret: String?
}

private struct KeychainSecretResultPayload: Encodable {
  let secret: String?
  let error: String?
}

private func bridgeString(_ value: String) -> UnsafeMutablePointer<CChar>? {
  strdup(value)
}

private func statusMessage(_ status: OSStatus) -> String {
  if let text = SecCopyErrorMessageString(status, nil) as String? {
    return text
  }
  return "OSStatus \(status)"
}

private func keychainBaseQuery(service: String, account: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
  ]
}

private func normalizeMountErrorKind(status: Int32, message: String) -> String {
  let lowered = message.lowercased()
  if status == -128 {
    return "userCancelled"
  }
  if lowered.contains("auth") || lowered.contains("password") || lowered.contains("credential") || lowered.contains("login") {
    return "auth"
  }
  if lowered.contains("share") || lowered.contains("no such file") || lowered.contains("not found") {
    return "shareNotFound"
  }
  return "mountFailed"
}

private func relativePath(from rootPath: String, to fullPath: String) -> String {
  let normalizedRoot = URL(fileURLWithPath: rootPath).standardizedFileURL.path
  let normalizedFull = URL(fileURLWithPath: fullPath).standardizedFileURL.path
  guard normalizedFull.hasPrefix(normalizedRoot) else {
    return "."
  }

  let suffix = normalizedFull.dropFirst(normalizedRoot.count)
  let trimmed = suffix.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  return trimmed.isEmpty ? "." : trimmed
}

private func encodeJSON<T: Encodable>(_ payload: T) -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  guard let data = try? encoder.encode(payload),
        let string = String(data: data, encoding: .utf8) else {
    return #"{"error":"Failed to encode native Apple bridge payload."}"#
  }
  return string
}

private func blockingBridgeCall<T: Encodable>(_ work: @escaping () async -> T) -> UnsafeMutablePointer<CChar>? {
  let semaphore = DispatchSemaphore(value: 0)
  var response = #"{"error":"Unknown native Apple bridge error."}"#
  Task {
    let payload = await work()
    response = encodeJSON(payload)
    semaphore.signal()
  }
  semaphore.wait()
  return bridgeString(response)
}

@MainActor
private func purchaseSupporter(productId: String) async -> PurchasePayload {
  do {
    let products = try await Product.products(for: [productId])
    guard let product = products.first else {
      return PurchasePayload(
        success: false,
        active: false,
        cancelled: false,
        pending: false,
        productId: productId,
        error: "The App Store product could not be loaded."
      )
    }

    let result = try await product.purchase()
    switch result {
    case .success(let verification):
      switch verification {
      case .verified(let transaction):
        await transaction.finish()
        return PurchasePayload(
          success: true,
          active: transaction.revocationDate == nil,
          cancelled: false,
          pending: false,
          productId: transaction.productID,
          error: nil
        )
      case .unverified(_, let error):
        return PurchasePayload(
          success: false,
          active: false,
          cancelled: false,
          pending: false,
          productId: productId,
          error: "Purchase verification failed: \(error.localizedDescription)"
        )
      }
    case .pending:
      return PurchasePayload(
        success: false,
        active: false,
        cancelled: false,
        pending: true,
        productId: productId,
        error: nil
      )
    case .userCancelled:
      return PurchasePayload(
        success: false,
        active: false,
        cancelled: true,
        pending: false,
        productId: productId,
        error: nil
      )
    @unknown default:
      return PurchasePayload(
        success: false,
        active: false,
        cancelled: false,
        pending: false,
        productId: productId,
        error: "The App Store returned an unknown purchase result."
      )
    }
  } catch {
    return PurchasePayload(
      success: false,
      active: false,
      cancelled: false,
      pending: false,
      productId: productId,
      error: error.localizedDescription
    )
  }
}

private func currentSupporterStatus(productId: String) async -> SupporterStatusPayload {
  for await entitlement in Transaction.currentEntitlements {
    switch entitlement {
    case .verified(let transaction):
      guard transaction.productID == productId else {
        continue
      }
      if transaction.revocationDate == nil {
        return SupporterStatusPayload(
          active: true,
          productId: transaction.productID,
          error: nil
        )
      }
    case .unverified(_, _):
      continue
    }
  }

  return SupporterStatusPayload(active: false, productId: nil, error: nil)
}

@MainActor
private func restoreSupporter(productId: String) async -> PurchasePayload {
  do {
    try await AppStore.sync()
    let status = await currentSupporterStatus(productId: productId)
    return PurchasePayload(
      success: status.active,
      active: status.active,
      cancelled: false,
      pending: false,
      productId: status.productId ?? productId,
      error: status.active ? nil : "No restored purchase was found for this Apple ID."
    )
  } catch {
    return PurchasePayload(
      success: false,
      active: false,
      cancelled: false,
      pending: false,
      productId: productId,
      error: error.localizedDescription
    )
  }
}

@_cdecl("syncwatcher_storekit_get_supporter_status")
public func syncwatcher_storekit_get_supporter_status(_ productIdPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let productIdPtr else {
    return bridgeString(#"{"active":false,"error":"Missing App Store product ID."}"#)
  }
  let productId = String(cString: productIdPtr)
  return blockingBridgeCall {
    await currentSupporterStatus(productId: productId)
  }
}

@_cdecl("syncwatcher_storekit_purchase_supporter")
public func syncwatcher_storekit_purchase_supporter(_ productIdPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let productIdPtr else {
    return bridgeString(#"{"success":false,"active":false,"cancelled":false,"pending":false,"error":"Missing App Store product ID."}"#)
  }
  let productId = String(cString: productIdPtr)
  return blockingBridgeCall {
    await purchaseSupporter(productId: productId)
  }
}

@_cdecl("syncwatcher_storekit_restore_supporter")
public func syncwatcher_storekit_restore_supporter(_ productIdPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let productIdPtr else {
    return bridgeString(#"{"success":false,"active":false,"cancelled":false,"pending":false,"error":"Missing App Store product ID."}"#)
  }
  let productId = String(cString: productIdPtr)
  return blockingBridgeCall {
    await restoreSupporter(productId: productId)
  }
}

@_cdecl("syncwatcher_create_security_scoped_bookmark")
public func syncwatcher_create_security_scoped_bookmark(_ pathPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let pathPtr else {
    return bridgeString(#"{"path":"","bookmark":"","error":"Missing path."}"#)
  }

  let path = String(cString: pathPtr)
  let url = URL(fileURLWithPath: path)

  do {
    let bookmark = try url.bookmarkData(
      options: [.withSecurityScope],
      includingResourceValuesForKeys: nil,
      relativeTo: nil
    )
    let payload = BookmarkCapturePayload(
      path: path,
      bookmark: bookmark.base64EncodedString(),
      error: nil
    )
    return bridgeString(encodeJSON(payload))
  } catch {
    let payload = BookmarkCapturePayload(
      path: path,
      bookmark: "",
      error: "Failed to create a security-scoped bookmark: \(error.localizedDescription)"
    )
    return bridgeString(encodeJSON(payload))
  }
}

@_cdecl("syncwatcher_resolve_security_scoped_bookmark")
public func syncwatcher_resolve_security_scoped_bookmark(_ bookmarkPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let bookmarkPtr else {
    return bridgeString(#"{"path":"","stale":false,"error":"Missing bookmark."}"#)
  }

  let bookmarkString = String(cString: bookmarkPtr)
  guard let data = Data(base64Encoded: bookmarkString) else {
    return bridgeString(#"{"path":"","stale":false,"error":"Bookmark data is not valid base64."}"#)
  }

  do {
    var stale = false
    let url = try URL(
      resolvingBookmarkData: data,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &stale
    )
    let didStart = url.startAccessingSecurityScopedResource()
    let payload = BookmarkResolvePayload(
      path: url.path,
      stale: stale || !didStart,
      error: didStart ? nil : "Failed to start security-scoped access."
    )
    return bridgeString(encodeJSON(payload))
  } catch {
    let payload = BookmarkResolvePayload(
      path: "",
      stale: false,
      error: "Failed to resolve security-scoped bookmark: \(error.localizedDescription)"
    )
    return bridgeString(encodeJSON(payload))
  }
}

@_cdecl("syncwatcher_capture_network_mount")
public func syncwatcher_capture_network_mount(_ pathPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let pathPtr else {
    return bridgeString(#"{"scheme":"","remountUrl":"","mountRootPath":"","relativePathFromMountRoot":"","error":"Missing path."}"#)
  }

  let path = String(cString: pathPtr)
  let url = URL(fileURLWithPath: path)

  do {
    let values = try url.resourceValues(forKeys: [.volumeURLForRemountingKey, .volumeURLKey])
    guard let remountURL = values.volumeURLForRemounting else {
      let payload = NetworkMountCapturePayload(
        scheme: "",
        remountUrl: "",
        username: nil,
        mountRootPath: "",
        relativePathFromMountRoot: ".",
        error: nil
      )
      return bridgeString(encodeJSON(payload))
    }

    guard remountURL.scheme?.lowercased() == "smb" else {
      let payload = NetworkMountCapturePayload(
        scheme: remountURL.scheme?.lowercased() ?? "",
        remountUrl: remountURL.absoluteString,
        username: remountURL.user,
        mountRootPath: values.volume?.path ?? "",
        relativePathFromMountRoot: ".",
        error: "Unsupported network scheme."
      )
      return bridgeString(encodeJSON(payload))
    }

    let mountRootPath = values.volume?.path ?? path
    let payload = NetworkMountCapturePayload(
      scheme: "smb",
      remountUrl: remountURL.absoluteString,
      username: remountURL.user,
      mountRootPath: mountRootPath,
      relativePathFromMountRoot: relativePath(from: mountRootPath, to: path),
      error: nil
    )
    return bridgeString(encodeJSON(payload))
  } catch {
    let payload = NetworkMountCapturePayload(
      scheme: "",
      remountUrl: "",
      username: nil,
      mountRootPath: "",
      relativePathFromMountRoot: ".",
      error: "Failed to capture network mount metadata: \(error.localizedDescription)"
    )
    return bridgeString(encodeJSON(payload))
  }
}

@_cdecl("syncwatcher_mount_network_share")
public func syncwatcher_mount_network_share(_ payloadPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let payloadPtr else {
    return bridgeString(#"{"mountPath":"","errorKind":"mountFailed","error":"Missing payload."}"#)
  }

  let payloadString = String(cString: payloadPtr)
  guard let data = payloadString.data(using: .utf8) else {
    return bridgeString(#"{"mountPath":"","errorKind":"mountFailed","error":"Payload is not valid UTF-8."}"#)
  }

  do {
    let payload = try JSONDecoder().decode(NetworkMountRequestPayload.self, from: data)
    guard let url = URL(string: payload.remountUrl) else {
      return bridgeString(#"{"mountPath":"","errorKind":"mountFailed","error":"Remount URL is invalid."}"#)
    }
    guard url.scheme?.lowercased() == "smb" else {
      return bridgeString(#"{"mountPath":"","errorKind":"unsupportedScheme","error":"Unsupported network scheme."}"#)
    }

    let openOptions = NSMutableDictionary()
    let mountOptions = NSMutableDictionary()
    mountOptions[kNetFSOpenURLMountKey as String] = true
    var mountPoints: Unmanaged<CFArray>?
    let status = NetFSMountURLSync(
      url as CFURL,
      nil,
      payload.username as CFString?,
      payload.password as CFString?,
      openOptions,
      mountOptions,
      &mountPoints
    )

    guard status == 0 else {
      let message = statusMessage(OSStatus(status))
      let payload = NetworkMountResultPayload(
        mountPath: "",
        errorKind: normalizeMountErrorKind(status: status, message: message),
        error: message
      )
      return bridgeString(encodeJSON(payload))
    }

    let mountedPaths = mountPoints?.takeRetainedValue() as? [String]
    let mountPath = mountedPaths?.first ?? ""
    let result = NetworkMountResultPayload(
      mountPath: mountPath,
      errorKind: nil,
      error: nil
    )
    return bridgeString(encodeJSON(result))
  } catch {
    let payload = NetworkMountResultPayload(
      mountPath: "",
      errorKind: "mountFailed",
      error: "Failed to decode mount payload: \(error.localizedDescription)"
    )
    return bridgeString(encodeJSON(payload))
  }
}

@_cdecl("syncwatcher_store_keychain_secret")
public func syncwatcher_store_keychain_secret(_ payloadPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let payloadPtr else {
    return bridgeString(#"{"error":"Missing payload."}"#)
  }

  let payloadString = String(cString: payloadPtr)
  guard let data = payloadString.data(using: .utf8) else {
    return bridgeString(#"{"error":"Payload is not valid UTF-8."}"#)
  }

  do {
    let payload = try JSONDecoder().decode(KeychainSecretPayload.self, from: data)
    guard let secret = payload.secret, !secret.isEmpty else {
      return bridgeString(#"{"error":"Secret is required."}"#)
    }

    let baseQuery = keychainBaseQuery(service: payload.service, account: payload.account)
    SecItemDelete(baseQuery as CFDictionary)
    var addQuery = baseQuery
    addQuery[kSecValueData as String] = secret.data(using: .utf8)
    let status = SecItemAdd(addQuery as CFDictionary, nil)
    if status != errSecSuccess {
      return bridgeString(encodeJSON(KeychainSecretResultPayload(secret: nil, error: "Failed to store keychain secret: \(statusMessage(status))")))
    }
    return bridgeString(#"{}"#)
  } catch {
    return bridgeString(#"{"error":"Failed to decode keychain payload."}"#)
  }
}

@_cdecl("syncwatcher_read_keychain_secret")
public func syncwatcher_read_keychain_secret(_ payloadPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let payloadPtr else {
    return bridgeString(#"{"secret":null,"error":"Missing payload."}"#)
  }

  let payloadString = String(cString: payloadPtr)
  guard let data = payloadString.data(using: .utf8) else {
    return bridgeString(#"{"secret":null,"error":"Payload is not valid UTF-8."}"#)
  }

  do {
    let payload = try JSONDecoder().decode(KeychainSecretPayload.self, from: data)
    var query = keychainBaseQuery(service: payload.service, account: payload.account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return bridgeString(encodeJSON(KeychainSecretResultPayload(secret: nil, error: nil)))
    }
    if status != errSecSuccess {
      return bridgeString(encodeJSON(KeychainSecretResultPayload(secret: nil, error: "Failed to read keychain secret: \(statusMessage(status))")))
    }
    let secretData = result as? Data
    let secret = secretData.flatMap { String(data: $0, encoding: .utf8) }
    return bridgeString(encodeJSON(KeychainSecretResultPayload(secret: secret, error: nil)))
  } catch {
    return bridgeString(#"{"secret":null,"error":"Failed to decode keychain payload."}"#)
  }
}

@_cdecl("syncwatcher_delete_keychain_secret")
public func syncwatcher_delete_keychain_secret(_ payloadPtr: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  guard let payloadPtr else {
    return bridgeString(#"{"error":"Missing payload."}"#)
  }

  let payloadString = String(cString: payloadPtr)
  guard let data = payloadString.data(using: .utf8) else {
    return bridgeString(#"{"error":"Payload is not valid UTF-8."}"#)
  }

  do {
    let payload = try JSONDecoder().decode(KeychainSecretPayload.self, from: data)
    let status = SecItemDelete(keychainBaseQuery(service: payload.service, account: payload.account) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
      return bridgeString(#"{"error":"Failed to delete keychain secret."}"#)
    }
    return bridgeString(#"{}"#)
  } catch {
    return bridgeString(#"{"error":"Failed to decode keychain payload."}"#)
  }
}

@_cdecl("syncwatcher_free_bridge_string")
public func syncwatcher_free_bridge_string(_ value: UnsafeMutablePointer<CChar>?) {
  guard let value else {
    return
  }
  free(value)
}
