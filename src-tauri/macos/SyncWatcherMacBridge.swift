import Foundation
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

private func bridgeString(_ value: String) -> UnsafeMutablePointer<CChar>? {
  strdup(value)
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

@_cdecl("syncwatcher_free_bridge_string")
public func syncwatcher_free_bridge_string(_ value: UnsafeMutablePointer<CChar>?) {
  guard let value else {
    return
  }
  free(value)
}
